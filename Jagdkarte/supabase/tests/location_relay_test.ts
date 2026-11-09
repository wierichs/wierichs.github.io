import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';

const profile = 'c76274b7-e21a-440e-ad0d-c51c6f6345e0';
const owner = 'cdde89af-26df-4d34-a6ca-0ff20f367cc1';
const member = 'fa51c814-88e7-49fc-bc6f-94281acccdb3';
function assert(value: unknown): asserts value { if (!value) throw new Error('Assertion failed'); }

async function setup() {
  const database = new PGlite();
  await database.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.hunting_profiles(id uuid primary key, owner_id uuid, hunting_mode boolean default true, boundary_geojson jsonb);
    create table public.hunting_profile_members(profile_id uuid, user_id uuid, role text default 'guest');
    create table public.hunting_dogs(id uuid primary key, profile_id uuid);
    create table public.hunting_dog_devices(id uuid primary key, dog_id uuid, relay_signing_public_key text, revoked_at timestamptz);
    create table public.hunting_profile_locations(profile_id uuid, user_id uuid, latitude float8, longitude float8,
      accuracy float8, updated_at timestamptz, primary key(profile_id,user_id));
    create table public.hunting_dog_locations(dog_id uuid primary key, profile_id uuid, latitude float8, longitude float8,
      accuracy float8, recorded_at timestamptz, received_at timestamptz default now());
    create function public.can_view_hunting_profile(profile_uuid uuid) returns boolean language sql security definer as $$
      select exists(select 1 from public.hunting_profiles p where p.id=profile_uuid and
        (p.owner_id=auth.uid() or exists(select 1 from public.hunting_profile_members m where m.profile_id=p.id and m.user_id=auth.uid()))) $$;
    create function public.can_edit_hunting_profile(profile_uuid uuid) returns boolean language sql security definer as $$
      select exists(select 1 from public.hunting_profiles where id=profile_uuid and owner_id=auth.uid()) $$;
    create function public.hunting_mode_is_enabled(profile_uuid uuid) returns boolean language sql security definer as $$
      select exists(select 1 from public.hunting_profiles where id=profile_uuid and hunting_mode) $$;
    create function extensions.st_geomfromgeojson(value text) returns jsonb language sql immutable as $$ select value::jsonb $$;
    create function extensions.st_setsrid(value jsonb, srid integer) returns jsonb language sql immutable as $$ select value $$;
    create function extensions.st_makepoint(longitude float8, latitude float8) returns jsonb language sql immutable as $$ select jsonb_build_array(longitude,latitude) $$;
    create function extensions.st_covers(boundary jsonb, point jsonb) returns boolean language sql immutable as $$
      select (point->>0)::float8 between 6 and 8 and (point->>1)::float8 between 50 and 52 $$;
    insert into auth.users values('${owner}'),('${member}');
    insert into public.hunting_profiles values('${profile}','${owner}',true,'{}');
    insert into public.hunting_profile_members(profile_id,user_id) values('${profile}','${member}');
    grant usage on schema auth,public to authenticated, service_role;
  `);
  await database.exec(await Deno.readTextFile(new URL('../migrations/202611020001_location_relay.sql', import.meta.url)));
  await database.query(`select set_config('request.jwt.claim.sub',$1,false)`, [owner]);
  const key = 'A'.repeat(400);
  const device = (await database.query<{ id: string }>(`select public.register_hunting_relay_device($1,$2) id`, [profile, key])).rows[0].id;
  await database.query('select public.set_hunting_relay_sharing($1,true)', [device]);
  return { database, device, key };
}

async function record(database: PGlite, device: string, options: { message?: string; digest?: string; sequence?: number;
  age?: number; longitude?: number; origin?: string; epoch?: string } = {}) {
  const epoch = options.epoch ?? (await database.query<{ sharing_epoch: string }>('select sharing_epoch from public.hunting_relay_devices where id=$1',
    [options.origin ?? device])).rows[0]?.sharing_epoch;
  return (await database.query<{ result: { accepted: boolean; duplicate: boolean; position_applied: boolean } }>(`
    select public.record_hunting_relay_location($1,$2,$3,$4,now()+interval '60 seconds',51,$5,5,
      now()-($6::integer * interval '1 second'),$7,$8) result`,
    [device, options.origin ?? device, options.message ?? crypto.randomUUID(), options.digest ?? 'a'.repeat(64),
      options.longitude ?? 7, options.age ?? 0, options.sequence ?? 1, epoch])).rows[0].result;
}

Deno.test('migration enforces RLS and authenticated/service-only function grants', async () => {
  const { database, device } = await setup();
  try {
    await database.exec('set role authenticated');
    let denied = false;
    try { await database.query('select * from public.hunting_relay_devices'); } catch { denied = true; }
    assert(denied);
    denied = false;
    try { await record(database, device); } catch { denied = true; }
    assert(denied);
    await database.exec('reset role');
  } finally { await database.close(); }
});

Deno.test('message ledger is idempotent and binds message ID to immutable content', async () => {
  const { database, device } = await setup();
  try {
    const message = crypto.randomUUID();
    assert((await record(database, device, { message })).position_applied);
    assert((await record(database, device, { message })).duplicate);
    let rejected = false;
    try { await record(database, device, { message, digest: 'b'.repeat(64) }); } catch { rejected = true; }
    assert(rejected);
    assert((await database.query<{ count: number }>('select count(*)::int count from public.hunting_relay_messages')).rows[0].count === 1);
  } finally { await database.close(); }
});

Deno.test('old measurement or sequence cannot overwrite a newer participant position', async () => {
  const { database, device } = await setup();
  try {
    assert((await record(database, device, { sequence: 2 })).position_applied);
    assert(!(await record(database, device, { sequence: 1, age: 5 })).position_applied);
    assert((await database.query<{ last_sequence: number }>('select last_sequence::int from public.hunting_relay_devices')).rows[0].last_sequence === 2);
  } finally { await database.close(); }
});

Deno.test('revocation, removed membership and inactive hunting mode reject uploads', async () => {
  const { database, device, key } = await setup();
  try {
    await database.exec(`update public.hunting_profiles set hunting_mode=false`);
    let rejected = false;
    try { await record(database, device); } catch { rejected = true; }
    assert(rejected);
    await database.exec(`update public.hunting_profiles set hunting_mode=true`);
    await database.query(`select public.revoke_hunting_relay_device($1)`, [device]);
    rejected = false;
    try { await record(database, device); } catch { rejected = true; }
    assert(rejected);
    await database.query(`select set_config('request.jwt.claim.sub',$1,false)`, [member]);
    const memberDevice = (await database.query<{ id: string }>(`select public.register_hunting_relay_device($1,$2) id`, [profile, key])).rows[0].id;
    await database.exec(`delete from public.hunting_profile_members`);
    rejected = false;
    try { await record(database, memberDevice); } catch { rejected = true; }
    assert(rejected);
  } finally { await database.close(); }
});

Deno.test('invalid or out-of-boundary participant upload leaves no message receipt', async () => {
  const { database, device } = await setup();
  try {
    let rejected = false;
    try { await record(database, device, { longitude: 10 }); } catch { rejected = true; }
    assert(rejected);
    assert((await database.query<{ count: number }>('select count(*)::int count from public.hunting_relay_messages')).rows[0].count === 0);
  } finally { await database.close(); }
});

Deno.test('ending and restarting sharing invalidates all prior-session messages', async () => {
  const { database, device } = await setup();
  try {
    const epoch = (await database.query<{ sharing_epoch: string }>('select sharing_epoch from public.hunting_relay_devices')).rows[0].sharing_epoch;
    await database.query('select public.set_hunting_relay_sharing($1,false)', [device]);
    await database.query('select public.set_hunting_relay_sharing($1,true)', [device]);
    let rejected = false;
    try { await record(database, device, { epoch }); } catch { rejected = true; }
    assert(rejected);
    assert((await record(database, device)).accepted);
  } finally { await database.close(); }
});

Deno.test('hunting mode cycle cannot reactivate an old sharing session', async () => {
  const { database, device } = await setup();
  try {
    const epoch = (await database.query<{ sharing_epoch: string }>('select sharing_epoch from public.hunting_relay_devices')).rows[0].sharing_epoch;
    await database.exec('update public.hunting_profiles set hunting_mode=false; update public.hunting_profiles set hunting_mode=true;');
    await database.query('select public.set_hunting_relay_sharing($1,true)', [device]);
    let rejected = false;
    try { await record(database, device, { epoch }); } catch { rejected = true; }
    assert(rejected);
  } finally { await database.close(); }
});

Deno.test('gateway cannot upload for a device from a different revier', async () => {
  const { database, device, key } = await setup();
  try {
    const otherProfile = crypto.randomUUID();
    await database.query('insert into public.hunting_profiles values($1,$2,true,\'{}\')', [otherProfile, owner]);
    const otherDevice = (await database.query<{ id: string }>('select public.register_hunting_relay_device($1,$2) id', [otherProfile, key])).rows[0].id;
    await database.query('select public.set_hunting_relay_sharing($1,true)', [otherDevice]);
    let rejected = false;
    try { await record(database, device, { origin: otherDevice }); } catch { rejected = true; }
    assert(rejected);
  } finally { await database.close(); }
});

Deno.test('legacy dogs may be outside the revier but older fixes cannot replace newer ones', async () => {
  const { database, device, key } = await setup();
  try {
    const dog = crypto.randomUUID();
    const dogDevice = crypto.randomUUID();
    await database.query('insert into public.hunting_dogs values($1,$2)', [dog, profile]);
    await database.query('insert into public.hunting_dog_devices values($1,$2,$3,null)', [dogDevice, dog, key]);
    const query = `select public.record_hunting_relay_location($1,$2,$3,$4,now()+interval '1 hour',54,10,5,
      now()-($5::integer * interval '1 second'),null,null) result`;
    const first = await database.query<{ result: { position_applied: boolean } }>(query, [device, dogDevice, crypto.randomUUID(), 'a'.repeat(64), 0]);
    const older = await database.query<{ result: { position_applied: boolean } }>(query, [device, dogDevice, crypto.randomUUID(), 'b'.repeat(64), 5]);
    assert(first.rows[0].result.position_applied && !older.rows[0].result.position_applied);
  } finally { await database.close(); }
});