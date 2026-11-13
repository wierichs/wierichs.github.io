import assert from "node:assert/strict";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

Deno.test("Pairing status is read-only, role-scoped and specific to the scanned token", async (t) => {
  const db = new PGlite();
  const profile = "11111111-1111-4111-8111-111111111111";
  const dog = "22222222-2222-4222-8222-222222222222";
  const otherDog = "33333333-3333-4333-8333-333333333333";
  const owner = "44444444-4444-4444-8444-444444444444";
  const editor = "55555555-5555-4555-8555-555555555555";
  const guest = "66666666-6666-4666-8666-666666666666";
  const oldToken = "b".repeat(64);
  const token = "a".repeat(64);

  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create schema extensions;
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      grant usage on schema auth to anon, authenticated;
      create table public.hunting_profiles(id uuid primary key, owner_id uuid, editor_id uuid);
      create table public.hunting_dogs(id uuid primary key, profile_id uuid);
      create table public.hunting_dog_devices(dog_id uuid, token_hash text, revoked_at timestamptz);
      create table public.hunting_dog_device_pairings(dog_id uuid, token_hash text);
      create function public.can_edit_hunting_profile(id uuid) returns boolean
        language sql stable security definer set search_path = '' as
        $$select exists(select 1 from public.hunting_profiles p
          where p.id = $1 and auth.uid() in (p.owner_id, p.editor_id))$$;
      -- Use PostgreSQL's built-in SHA-256 in place of the Supabase pgcrypto wrapper.
      create function extensions.digest(value bytea, algorithm text) returns bytea
        language sql immutable as $$select sha256(value)$$;
      insert into public.hunting_profiles values ('${profile}', '${owner}', '${editor}');
      insert into public.hunting_dogs values ('${dog}', '${profile}'), ('${otherDog}', '${profile}');
      insert into public.hunting_dog_devices values
        ('${dog}', encode(sha256(convert_to('${oldToken}', 'UTF8')), 'hex'), null);
      insert into public.hunting_dog_device_pairings values
        ('${dog}', encode(sha256(convert_to('${token}', 'UTF8')), 'hex'));
    `);
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../migrations/202611130001_dog_device_pairing_status.sql",
          import.meta.url,
        ),
      ),
    );

    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../migrations/202611130002_dog_pairing_states.sql",
          import.meta.url,
        ),
      ),
    );

    async function states(identity: string, profileId = profile) {
      await db.exec("set role authenticated");
      try {
        await db.query(
          "select set_config('request.jwt.claim.sub', $1, false)",
          [identity],
        );
        return (await db.query<
          { dog_id: string; paired: boolean; pending: boolean }
        >(
          "select * from public.get_hunting_dog_pairing_states($1::uuid)",
          [profileId],
        )).rows;
      } finally {
        await db.exec("reset role");
      }
    }

    async function status(
      identity: string,
      deviceToken: string | null,
      dogId = dog,
    ) {
      await db.exec("set role authenticated");
      try {
        await db.query(
          "select set_config('request.jwt.claim.sub', $1, false)",
          [identity],
        );
        const result = await db.query<{ status: string }>(
          "select public.get_hunting_dog_device_pairing_status($1::uuid, $2::text) as status",
          [dogId, deviceToken],
        );
        return result.rows[0].status;
      } finally {
        await db.exec("reset role");
      }
    }

    await t.step(
      "dog list separates existing active devices from pending replacement",
      async () => {
        const expected = [
          { dog_id: dog, paired: true, pending: true },
          { dog_id: otherDog, paired: false, pending: false },
        ];
        assert.deepEqual(await states(owner), expected);
        assert.deepEqual(await states(editor), expected);
        await assert.rejects(
          states(guest),
          /Nur der Owner oder ein Bearbeiter/,
        );
        await assert.rejects(states(""), /Anmeldung erforderlich/);
        await assert.rejects(
          states(owner, "77777777-7777-4777-8777-777777777777"),
          /Nur der Owner oder ein Bearbeiter/,
        );
      },
    );

    await t.step(
      "owner and editor see pending, not an unrelated already-active tracker",
      async () => {
        assert.equal(await status(owner, token), "pending");
        assert.equal(await status(editor, token), "pending");
        assert.equal(await status(owner, oldToken), "active");
        assert.equal(await status(owner, token, otherDog), "not_found");
        const rows = await db.query<{ revoked_at: string | null }>(
          "select revoked_at from public.hunting_dog_devices",
        );
        assert.equal(rows.rows.length, 1);
        assert.equal(rows.rows[0].revoked_at, null);
      },
    );

    await t.step(
      "guest, missing authentication and invalid tokens are rejected",
      async () => {
        await assert.rejects(
          status(guest, token),
          /Nur der Owner oder ein Bearbeiter/,
        );
        await assert.rejects(status("", token), /Anmeldung erforderlich/);
        for (const invalid of [null, "invalid", "A".repeat(64)]) {
          await assert.rejects(
            status(owner, invalid),
            /Ungueltiger Hundegeraeteschluessel/,
          );
        }
        await db.exec("set role anon");
        try {
          await assert.rejects(
            db.query(
              "select public.get_hunting_dog_device_pairing_status($1::uuid, $2)",
              [dog, token],
            ),
            /permission denied for function/,
          );
          await assert.rejects(
            db.query(
              "select * from public.get_hunting_dog_pairing_states($1::uuid)",
              [profile],
            ),
            /permission denied for function/,
          );
        } finally {
          await db.exec("reset role");
        }
        const privileges = await db.query<
          { devices: boolean; pairings: boolean }
        >(`
        select has_table_privilege('authenticated', 'public.hunting_dog_devices', 'SELECT') as devices,
          has_table_privilege('authenticated', 'public.hunting_dog_device_pairings', 'SELECT') as pairings
      `);
        assert.deepEqual(privileges.rows[0], {
          devices: false,
          pairings: false,
        });
      },
    );

    await t.step(
      "activation is recognized only for this exact dog and token",
      async () => {
        await db.exec(`
        update public.hunting_dog_devices set revoked_at = now();
        insert into public.hunting_dog_devices values
          ('${dog}', encode(sha256(convert_to('${token}', 'UTF8')), 'hex'), null);
        delete from public.hunting_dog_device_pairings;
      `);
        assert.equal(await status(owner, token), "active");
        assert.deepEqual((await states(owner))[0], {
          dog_id: dog,
          paired: true,
          pending: false,
        });
        assert.equal(await status(owner, oldToken), "not_found");
        assert.equal(await status(owner, token, otherDog), "not_found");
      },
    );

    await t.step(
      "revoked or cancelled pairings never report success",
      async () => {
        await db.exec(
          "update public.hunting_dog_devices set revoked_at = now()",
        );
        assert.equal(await status(owner, token), "not_found");
        assert.deepEqual((await states(owner))[0], {
          dog_id: dog,
          paired: false,
          pending: false,
        });
        await db.exec(`
        insert into public.hunting_dog_device_pairings values
          ('${dog}', encode(sha256(convert_to('${token}', 'UTF8')), 'hex'));
      `);
        assert.equal(await status(owner, token), "pending");
        await db.exec("delete from public.hunting_dog_device_pairings");
        assert.equal(await status(owner, token), "not_found");
      },
    );
  } finally {
    await db.close();
  }
});
