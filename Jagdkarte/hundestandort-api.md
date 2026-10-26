# Schnittstelle fuer Hundestandorte

Diese Schnittstelle verbindet eine spaetere Smartphone-App mit den in der
Jagdkarte registrierten Hunden. Sie uebertraegt ausschliesslich die jeweils
letzte Position, keine Route und keinen Positionsverlauf.

## Voraussetzungen

1. `schema.sql` muss im zugehoerigen Supabase-Projekt ausgefuehrt worden sein.
2. Die Edge Function `dog-location` muss aus dem Verzeichnis `Jagdkarte` mit
   der Supabase CLI deployed sein:

   ```sh
   supabase functions deploy dog-location --project-ref <project-ref>
   ```

3. Die Funktion verwendet `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` aus der
   Supabase-Laufzeitumgebung. Der Service-Role-Key darf niemals in der
   Smartphone-App, in `config.js` oder in diesem Repository stehen.

Die Funktion hat `verify_jwt = false`, weil ein Smartphone keinen Supabase-
Benutzer-JWT fuer den Upload verwendet. Stattdessen prueft sie den
hoch-entropischen, hundespezifischen Geraeteschluessel selbst.

## Hund und Geraet koppeln

Owner und Bearbeiter legen einen Hund im ausgewaehlten Revierprofil an. Mit
**Smartphone koppeln** erzeugt die Jagdkarte einen zufaelligen Schluessel mit
256 Bit Entropie. Er wird genau einmal angezeigt und muss von der Smartphone-
App sicher gespeichert werden (Android Keystore beziehungsweise iOS Keychain).
Die Datenbank speichert nur seinen SHA-256-Hash. Ein neu ausgestellter
Schluessel widerruft den vorherigen Schluessel fuer diesen Hund.

Die IMEI wird weder benoetigt noch gespeichert. Der Schluessel ist ein
Bearer-Geheimnis: Wer ihn besitzt, kann Positionen fuer den zugeordneten Hund
melden. Bei Verlust muss ein neuer Schluessel ausgestellt werden.

## Positionsmeldung

```http
POST https://<project-ref>.supabase.co/functions/v1/dog-location
Authorization: Bearer <device-token>
Content-Type: application/json
```

Request-Body:

```json
{
  "latitude": 51.1234,
  "longitude": 6.9876,
  "accuracy": 8.5,
  "recorded_at": "2026-10-26T12:34:56.000Z"
}
```

`recorded_at` ist der Zeitpunkt der GPS-Messung in ISO-8601/UTC. Die
Smartphone-App uebertraegt die Koordinaten als WGS84-Dezimalgrad. Die
Geraete-ID und Hund-ID werden nicht im Body benoetigt: Der Geraeteschluessel
identifiziert das gekoppelte Geraet und dessen Hund.

Empfohlener Startwert waehrend aktivem Jagdmodus: eine Meldung alle 15 Sekunden.
Die App kann spaeter bei Bewegung haeufiger und im Stillstand seltener senden.
Offline gepufferte Meldungen duerfen erneut gesendet werden; ein aelterer Fix
ueberschreibt niemals einen neueren.

## Antwort

Gespeicherter Fix:

```json
{
  "accepted": true,
  "received_at": "2026-10-26T12:35:00.000Z"
}
```

`accepted: false` bedeutet, dass der Request authentifiziert war, der Fix aber
aelter als die bereits gespeicherte letzte Position ist und deshalb nicht
uebernommen wurde.

| HTTP | Fehlercode | Bedeutung |
| --- | --- | --- |
| 400 | `invalid_json` / `invalid_payload` / `invalid_location` | Body, Koordinaten, Genauigkeit oder Zeitstempel ungueltig |
| 401 | `invalid_device_token` | Schluessel fehlt, ist falsch oder wurde widerrufen |
| 405 | `method_not_allowed` | Nur POST wird unterstuetzt |
| 409 | `hunting_mode_inactive` | Revier-Jagdmodus ist aus; es wird nichts gespeichert |
| 413 | `payload_too_large` | Request-Body groesser als 4 KiB |
| 503 | `service_unavailable` | Supabase oder Positionsspeicherung voruebergehend nicht verfuegbar |

## Sichtbarkeit und Aufbewahrung

Nur angemeldete Mitglieder des zugeordneten Revierprofils koennen Hunde sehen.
Positionen sind nur bei aktivem Jagdmodus lesbar. Das Ausschalten des Modus
loescht die gespeicherten letzten Positionen; erneute Meldungen werden bis zur
Reaktivierung abgelehnt. Beim Loeschen eines Hundes werden Geraet und Position
mitgeloescht.

Die Reviergrenze ist keine Positionsgrenze: Auch Fixes ausserhalb des Polygons
werden angenommen und auf der Karte angezeigt. Positionen aelter als zwei
Minuten werden in der Karte als veraltet markiert. Es wird keine Historie
angelegt.