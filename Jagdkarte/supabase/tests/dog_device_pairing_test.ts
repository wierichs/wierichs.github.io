import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';

const owner = 'cdde89af-26df-4d34-a6ca-0ff20f367cc1';
const otherUser = 'fa51c814-88e7-49fc-bc6f-94281acccdb3';
const profile = 'c76274b7-e21a-440e-ad0d-c51c6f6345e0';
const otherProfile = '77474a10-0ee7-49b6-9a7a-f4b7298e817d';
const dog = '772dbb51-bff6-4930-ae8c-82ea74925315';
const otherDog = '88a60dd5-4c86-47f6-a584-55ea13729ef2';
const restrictedDog = '86ec5090-758c-4bd1-a7e3-7ac0c05e6d7f';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

async function setup() {
  const database = new PGlite();
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema extensions;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function extensions.digest(value bytea, algorithm text) returns bytea
      language sql immutable as $$
        select decode(md5(encode(value, 'hex')) || md5(encode(value, 'hex')), 'hex')
      $$;
    create function extensions.gen_random_bytes(size integer) returns bytea
      language sql volatile as $$
        select substring(decode(repeat(md5(random()::text), 2), 'hex') from 1 for size)
      $$;
    create table public.hunting_profiles(id uuid primary key, owner_id uuid not null);
    create table public.hunting_profile_members(profile_id uuid, user_id uuid, role text);
    create table public.hunting_dogs(
      id uuid primary key,
      profile_id uuid not null references public.hunting_profiles(id) on delete cascade
    );
    create table public.hunting_dog_devices(
      id uuid primary key,
      dog_id uuid not null references public.hunting_dogs(id) on delete cascade,
      token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
      relay_signing_public_key text,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    );
    create unique index hunting_dog_devices_one_active_idx
      on public.hunting_dog_devices(dog_id) where revoked_at is null;
    create function public.can_edit_hunting_profile(profile_uuid uuid) returns boolean
      language sql security definer as $$
        select exists (
          select 1 from public.hunting_profiles p
          where p.id = profile_uuid and p.owner_id = auth.uid()
        ) or exists (
          select 1 from public.hunting_profile_members m
          where m.profile_id = profile_uuid and m.user_id = auth.uid() and m.role = 'editor'
        )
      $$;
    insert into auth.users values ('${owner}'), ('${otherUser}');
    insert into public.hunting_profiles values ('${profile}', '${owner}'), ('${otherProfile}', '${otherUser}');
    insert into public.hunting_dogs values ('${dog}', '${profile}'), ('${otherDog}', '${profile}'),
      ('${restrictedDog}', '${otherProfile}');
    grant usage on schema auth, public, extensions to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  await database.exec(await Deno.readTextFile(
    new URL('../migrations/202611110002_two_phase_dog_device_pairing.sql', import.meta.url)
  ));
  await database.query('select set_config(\'request.jwt.claim.sub\', $1, false)', [owner]);
  return database;
}

async function asRole(database: PGlite, role: 'anon' | 'authenticated', action: () => Promise<void>) {
  await database.exec(`set role ${role}`);
  try {
    await action();
  } finally {
    await database.exec('reset role');
  }
}

async function stage(database: PGlite, targetDog: string, token: string) {
  return await database.query<{ id: string }>(
    'select public.stage_hunting_dog_device_token($1, $2) id',
    [targetDog, token]
  );
}

async function complete(database: PGlite, token: string, confirm: boolean) {
  return (await database.query<{ status: string }>(
    'select public.complete_hunting_dog_device_pairing($1, $2) status',
    [token, confirm]
  )).rows[0].status;
}

async function tokenHash(database: PGlite, token: string) {
  return (await database.query<{ hash: string }>(
    "select encode(extensions.digest(convert_to($1, 'UTF8'), 'sha256'), 'hex') hash",
    [token]
  )).rows[0].hash;
}

Deno.test('staging preserves the active key and confirmation is retryable after commit', async () => {
  const database = await setup();
  try {
    const oldHash = 'd'.repeat(64);
    const token = 'a'.repeat(64);
    await database.query('insert into public.hunting_dog_devices(id,dog_id,token_hash) values($1,$2,$3)',
      [crypto.randomUUID(), dog, oldHash]);

    let firstPairingId = '';
    await asRole(database, 'authenticated', async () => {
      firstPairingId = (await stage(database, dog, token)).rows[0].id;
      const repeatedPairingId = (await stage(database, dog, token)).rows[0].id;
      assert(firstPairingId === repeatedPairingId, 'Repeated QR scans must be idempotent');
    });

    const beforeConfirm = await database.query<{ active: number; pending: number }>(`
      select
        (select count(*)::int from public.hunting_dog_devices where dog_id = $1 and revoked_at is null) active,
        (select count(*)::int from public.hunting_dog_device_pairings where dog_id = $1) pending
    `, [dog]);
    assert(beforeConfirm.rows[0].active === 1 && beforeConfirm.rows[0].pending === 1,
      'Staging must preserve the previous active key');

    let firstStatus = '';
    await asRole(database, 'anon', async () => { firstStatus = await complete(database, token, true); });
    assert(firstStatus === 'activated');
    let retryStatus = '';
    await asRole(database, 'anon', async () => { retryStatus = await complete(database, token, true); });
    assert(retryStatus === 'already_active', 'A retry after an ambiguous timeout must succeed');

    const afterConfirm = await database.query<{ active: number; pending: number; active_hash: string }>(`
      select
        (select count(*)::int from public.hunting_dog_devices where dog_id = $1 and revoked_at is null) active,
        (select count(*)::int from public.hunting_dog_device_pairings where dog_id = $1) pending,
        (select token_hash from public.hunting_dog_devices where dog_id = $1 and revoked_at is null) active_hash
    `, [dog]);
    assert(afterConfirm.rows[0].active === 1 && afterConfirm.rows[0].pending === 0);
    assert(afterConfirm.rows[0].active_hash === await tokenHash(database, token));
    const oldKey = await database.query<{ revoked_at: string | null }>(
      'select revoked_at from public.hunting_dog_devices where dog_id = $1 and token_hash = $2',
      [dog, oldHash]
    );
    assert(oldKey.rows[0].revoked_at !== null);

    let activeId = '';
    await asRole(database, 'authenticated', async () => {
      activeId = (await stage(database, dog, token)).rows[0].id;
    });
    const activeDevice = await database.query(
      'select id from public.hunting_dog_devices where id = $1 and revoked_at is null',
      [activeId]
    );
    assert(activeDevice.rows.length === 1, 'A repeated active QR returns its active device id');
  } finally {
    await database.close();
  }
});

Deno.test('aborting a pending key leaves the old key active', async () => {
  const database = await setup();
  try {
    const oldHash = 'e'.repeat(64);
    const token = 'b'.repeat(64);
    await database.query('insert into public.hunting_dog_devices(id,dog_id,token_hash) values($1,$2,$3)',
      [crypto.randomUUID(), dog, oldHash]);
    await asRole(database, 'authenticated', async () => { await stage(database, dog, token); });

    let result = '';
    await asRole(database, 'anon', async () => { result = await complete(database, token, false); });
    assert(result === 'cancelled');
    const devices = await database.query<{ active: number; pending: number }>(`
      select
        (select count(*)::int from public.hunting_dog_devices where dog_id = $1 and revoked_at is null) active,
        (select count(*)::int from public.hunting_dog_device_pairings where dog_id = $1) pending
    `, [dog]);
    assert(devices.rows[0].active === 1 && devices.rows[0].pending === 0);
    assert(await complete(database, token, false) === 'not_found');
  } finally {
    await database.close();
  }
});

Deno.test('completion requires an explicit confirmation or abort decision', async () => {
  const database = await setup();
  try {
    let rejected = false;
    try {
      await database.query('select public.complete_hunting_dog_device_pairing($1, null)', ['a'.repeat(64)]);
    } catch {
      rejected = true;
    }
    assert(rejected);
  } finally {
    await database.close();
  }
});

Deno.test('unauthorized targets and cross-dog QR reuse do not replace active keys', async () => {
  const database = await setup();
  try {
    const token = 'c'.repeat(64);
    const oldHash = 'f'.repeat(64);
    await database.query('insert into public.hunting_dog_devices(id,dog_id,token_hash) values($1,$2,$3)',
      [crypto.randomUUID(), dog, oldHash]);

    await asRole(database, 'authenticated', async () => {
      await stage(database, dog, token);
      let collisionRejected = false;
      try { await stage(database, otherDog, token); } catch { collisionRejected = true; }
      assert(collisionRejected, 'The same QR must not be assigned to a different dog');
    });

    let unauthorizedRejected = false;
    await asRole(database, 'authenticated', async () => {
      try { await stage(database, restrictedDog, '1'.repeat(64)); } catch { unauthorizedRejected = true; }
    });
    assert(unauthorizedRejected, 'A user without edit access cannot stage a key for another profile');
    const state = await database.query<{ active: number; pending: number }>(`
      select
        (select count(*)::int from public.hunting_dog_devices where dog_id = $1 and revoked_at is null) active,
        (select count(*)::int from public.hunting_dog_device_pairings where dog_id = $1) pending
    `, [dog]);
    assert(state.rows[0].active === 1 && state.rows[0].pending === 1);
    const otherProfileRows = await database.query<{ count: number }>(
      'select count(*)::int count from public.hunting_dog_device_pairings where dog_id = $1',
      [restrictedDog]
    );
    assert(otherProfileRows.rows[0].count === 0);
  } finally {
    await database.close();
  }
});

Deno.test('Jagdkarte-generated QR still activates immediately and invalidates stale pending QR', async () => {
  const database = await setup();
  try {
    const oldHash = '9'.repeat(64);
    const pendingToken = '8'.repeat(64);
    await database.query('insert into public.hunting_dog_devices(id,dog_id,token_hash) values($1,$2,$3)',
      [crypto.randomUUID(), dog, oldHash]);
    await asRole(database, 'authenticated', async () => { await stage(database, dog, pendingToken); });

    let newToken = '';
    await asRole(database, 'authenticated', async () => {
      const created = await database.query<{ device_token: string }>(
        'select device_token from public.create_hunting_dog_device($1)',
        [dog]
      );
      newToken = created.rows[0].device_token;
    });
    assert(newToken.length === 64);
    assert(await complete(database, pendingToken, true) === 'not_found');
    const active = await database.query<{ token_hash: string; count: number }>(`
      select
        (select token_hash from public.hunting_dog_devices where dog_id = $1 and revoked_at is null) token_hash,
        (select count(*)::int from public.hunting_dog_device_pairings where dog_id = $1) count
    `, [dog]);
    assert(active.rows[0].token_hash === await tokenHash(database, newToken));
    assert(active.rows[0].count === 0);
  } finally {
    await database.close();
  }
});
