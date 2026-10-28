# Supabase-Hundestandort-Relais

Die Funktion `dog-location-relay` ergaenzt die Hundestandort-Schnittstelle und
aendert `dog-location` nicht. Die Android-App unterstuetzt
Schluesselregistrierung und opt-in Ein-Hop-Weitergabe ueber Nearby Connections.
Lokale Verbindungen erfordern einen bestaetigten Sicherheitscode.

## Sicherheitsmodell

- Ein Tracker registriert seinen oeffentlichen RSA-Signaturschluessel mit
  seinem bestehenden Geraeteschluessel.
- Ein Relais meldet sich mit seinem eigenen Geraeteschluessel an und erhaelt
  nie den Schluessel des Ursprungsgeraets.
- Das Ursprungsgeraet signiert die Relais-Metadaten und verschluesselt die
  Standortdaten fuer den Supabase-Server. Das Relais kann die Koordinaten nicht
  lesen.
- Die Funktion laesst nur Geraete aus demselben Revierprofil zu und uebergibt
  die Position an `record_hunting_dog_location` unter der ID des
  Ursprungsgeraets.
- Der private Entschluesselungsschluessel gehoert ausschliesslich in Supabase
  Secrets und darf nicht in Git, in die Android-App oder in Support-Nachrichten
  gelangen.

Die Signatur verwendet `RSASSA-PKCS1-v1_5` mit SHA-256 und einen als Base64url
codierten RSA-SPKI-Public-Key. Die Verschluesselung verwendet einen zufaelligen
AES-256-GCM-Schluessel pro Nachricht, der mit RSA-OAEP/SHA-256 fuer den Server
verschluesselt wird.

## Serverseitigen Schluessel erzeugen

Fuehre die Befehle auf einem vertrauenswuerdigen Rechner mit OpenSSL und
PowerShell aus. Die private PEM-Datei bleibt lokal und wird nicht ins
Repository uebernommen.

```powershell
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out relay-private.pem
openssl pkcs8 -topk8 -nocrypt -in relay-private.pem -outform DER -out relay-private.der
openssl pkey -in relay-private.pem -pubout -outform DER -out relay-public.der

function ConvertTo-Base64Url([string] $Path) {
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$privateKey = ConvertTo-Base64Url '.\relay-private.der'
$publicKey = ConvertTo-Base64Url '.\relay-public.der'
```

Bewahre beide Werte geschuetzt auf. Der private Schluessel wird nur als
Supabase Secret gespeichert. Die oeffentliche Haelfte darf an die App
ausgeliefert werden; die Funktion gibt sie ueber
`{"action":"get_server_key"}` zurueck.

## Schema und Deploy

Voraussetzung ist die Supabase CLI und die Verknuepfung dieses Projekts mit dem
richtigen Supabase-Projekt. Pruefe vor dem Ausfuehren von `schema.sql` das
Zielprojekt und erstelle ein Datenbank-Backup. Die Schemaerweiterung fuegt
lediglich `relay_signing_public_key` zu `hunting_dog_devices` hinzu.

1. Fuehre die aktualisierte `schema.sql` im SQL Editor des richtigen
   Supabase-Projekts aus.
2. Setze Projekt-Ref und die drei Relay-Secrets:

   ```powershell
   $projectRef = 'PROJECT_REF_AUS_DER_SUPABASE_DASHBOARD_URL'
   supabase link --project-ref $projectRef
   supabase secrets set --project-ref $projectRef `
     "RELAY_ENCRYPTION_KEY_ID=relay-1" `
     "RELAY_ENCRYPTION_PRIVATE_KEY=$privateKey" `
     "RELAY_ENCRYPTION_PUBLIC_KEY=$publicKey"
   ```

3. Deploye nur die neue Funktion:

   ```powershell
   supabase functions deploy dog-location-relay --project-ref $projectRef
   ```

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` werden von Supabase fuer Edge
Functions bereitgestellt. Setze den Service-Role-Key nicht selbst als
App-Konfiguration und veroeffentliche ihn nicht. Bewahre eine geschuetzte
Sicherung des privaten Verschluesselungsschluessels auf; ohne ihn koennen noch
nicht zugestellte, bereits verschluesselte Relaismeldungen nicht entschluesselt
werden. Entferne temporaere Dateien erst, wenn die Sicherung geprueft ist.

## API-Vertrag

Alle Anfragen sind `POST` mit JSON und optionalem
`Authorization: Bearer <Geraeteschluessel>`.

- `{"action":"get_server_key"}` gibt `key_id` und den oeffentlichen
  Verschluesselungsschluessel zurueck.
- `{"action":"register_key","public_key":"<base64url-SPKI>"}` registriert
  den Signaturschluessel des aufrufenden Geraets und antwortet mit
  `device_id`.
- `{"action":"relay", ...}` enthaelt `origin_device_id`, `message_id`,
  `expires_at`, `key_id`, `encrypted_key`, `nonce`, `ciphertext` und
  `signature`.

Die Signatur wird ueber UTF-8-Bytes der folgenden, mit Zeilenumbruechen
verbundenen Werte berechnet. Base64url-Werte werden ohne Padding uebertragen:

```text
dog-location-relay-v1
<origin_device_id in lowercase>
<message_id in lowercase>
<expires_at as canonical ISO-8601 UTC>
<key_id>
<encrypted_key>
<nonce>
<ciphertext>
```

`ciphertext` ist AES-GCM ueber das bisherige Standort-JSON (`latitude`,
`longitude`, `accuracy`, `recorded_at`). Der AES-Schluessel wird in
`encrypted_key` mit dem oeffentlichen Supabase-Schluessel verschluesselt.
`nonce` ist 12 Byte. Eine Nachricht darf hoechstens 24 Stunden gueltig und
hoechstens 24 Stunden alt sein.

Die Positions-RPC speichert nur den letzten Stand pro Hund und aktualisiert
ihn nur bei neuerem `recorded_at`. Wiederholungen und aeltere Meldungen
ueberschreiben daher keinen neueren Stand. Eine separate Tabelle zur
dauerhaften Deduplizierung nach `message_id` ist in dieser ersten Serverstufe
nicht enthalten.