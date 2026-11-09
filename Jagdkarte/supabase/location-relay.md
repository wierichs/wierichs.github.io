# Gemeinsames Revier-Relais

Diese additive Serverstufe gehoert zur nativen Android-Jagdkarte. Sie ist lokal
getestet, aber noch nicht bereitgestellt und aendert weder `dog-location` noch
`dog-location-relay`. Vor Produktion zuerst in einem Supabase-Testprojekt und
mit realen Smartphones abnehmen.

Die Android-App ergaenzt die PWA Jagdkarte, sie ersetzt sie nicht. Die PWA
bleibt mit ihrem jetzigen Funktionsumfang bestehen. Backend-Erweiterungen
muessen deshalb additiv und rueckwaertskompatibel sein. Vor einer gemeinsamen
Bereitstellung auch die bisherigen PWA-Ablaeufe und Schnittstellen auf dem
erweiterten Backend pruefen; keine Funktion darf allein durch die Android-
Erweiterung entfallen oder eingeschraenkt werden.

## Bereitstellung

Voraussetzungen: aktuelles Datenbankschema der Web-Jagdkarte mit PostGIS,
Benutzer-/Revierrollen und Hundegeraeten sowie Supabase CLI und Deno 2.5.6+.
Die neue Migration ersetzt das Basisschema nicht.

1. [migrations/202611020001_location_relay.sql](migrations/202611020001_location_relay.sql)
   im Testprojekt anwenden. Sie ergaenzt neue Tabellen und eingeschraenkte RPCs.
   Ein Trigger invalidiert Teilnehmerfreigaben beim Ausschalten des Jagdmodus.
   Mit pg_cron wird alle 15 Minuten aufgeraeumt; ohne pg_cron muss
   `cleanup_hunting_relay_messages()` extern regelmaessig ausgefuehrt werden.
2. Die drei bestehenden `RELAY_ENCRYPTION_*`-Secrets weiterverwenden. Vorhandene
   Verschluesselungsschluessel nicht ersetzen: Alte DogTracker-Umschlaege und
   deren laufende Installationen benoetigen genau diese Werte.
3. Ein separates RSA-3072-Schluesselpaar fuer Verzeichnisse und Bestaetigungen
   erzeugen. Aus diesem Supabase-Verzeichnis ausfuehren:

   ```powershell
   deno run --allow-write tools/generate-relay-keys.ts "$env:LOCALAPPDATA\Jagdkarte\relay-receipts.env"
   ```

   Das Werkzeug schreibt nur in eine neue Datei ausserhalb des Repositorys und
   protokolliert keine Schluessel. Auf Windows die Dateiberechtigungen auf den
   vorgesehenen Benutzer beschraenken. Nicht in Git einchecken oder im Chat
   ausgeben. Nur fuer ein **neues** Projekt ohne vorhandene Verschluesselungs-
   schluessel kann `--new-encryption` zusaetzlich die drei Verschluesselungswerte
   erzeugen. Standardmaessig entstehen nur `RELAY_RECEIPT_KEY_ID`,
   `RELAY_RECEIPT_PUBLIC_KEY` und `RELAY_RECEIPT_PRIVATE_KEY`.
4. Die neuen Secrets und ausschliesslich die neue Funktion bereitstellen:

   ```powershell
   supabase secrets set --env-file "$env:LOCALAPPDATA\Jagdkarte\relay-receipts.env" --project-ref <test-project-ref>
   ```

   Aus dem Repository-Wurzelverzeichnis:

   ```powershell
   supabase functions deploy location-relay --project-ref <test-project-ref> --no-verify-jwt
   ```

   Die Funktion benoetigt auch `SUPABASE_URL`, `SUPABASE_ANON_KEY` und
   `SUPABASE_SERVICE_ROLE_KEY` aus der Supabase-Laufzeit. Private Schluessel und
   Service-Role-Key gehoeren niemals in die App. Die vorgeschaltete JWT-Pruefung
   ist absichtlich aus: Die Funktion prueft entweder Benutzer-JWTs mit Supabase
   Auth `getUser` oder Hundeschluessel anhand ihres Hashs selbst.
5. Android fuer das Testprojekt bauen:

   ```powershell
   .\gradlew.bat :app:assembleDebug -PsupabaseUrl=https://<test-project-ref>.supabase.co -PsupabasePublishableKey=<public-publishable-key>
   ```

   Nur den oeffentlichen Publishable-/Anon-Key verwenden. Ein abweichendes
   Projekt erhaelt automatisch eine eigene Android-App-ID: Sitzungen, Schluessel
   und Outbox bleiben von Produktion getrennt. Ohne Parameter gilt die bisherige
   oeffentliche Projektkonfiguration. Es wurde kein Deploy ausgefuehrt und es
   wurden keine echten Secrets erzeugt.

## Android-Ablauf

1. Anmelden, Revier auswaehlen und Jagdmodus aktivieren.
2. **Relaisfreigabe** einschalten, gesondert zustimmen und die erforderlichen
   Benachrichtigungs-/Nearby-Berechtigungen freigeben. Die Erstregistrierung
   benoetigt Internet, aber keinen Hundeschluessel.
  Android kann fuer die Nearby-Geraetesuche auch groben und praezisen
  Standortzugriff verlangen; dadurch wird die eigene Revier-Standortfreigabe
  nicht aktiviert.
3. Fuer neue Funkverbindungen den Sicherheitscode auf beiden Geraeten vergleichen.
4. **Standort mit diesem Revier teilen** bleibt eine separate Entscheidung.
   Bei aktivem Relais werden eigene Fixes verschluesselt dauerhaft eingereiht.
   Auch die erste eigene Freigabe benoetigt Serverkontakt. Ohne Relais bleibt
   der bisherige direkte HTTPS-Standortpfad verfuegbar.
5. Die dauerhafte Benachrichtigung kann das Relais stoppen. Revierwechsel und
   Abmelden beenden die betreffende Gateway-Sitzung ebenfalls. Pro Smartphone
   laeuft entweder DogTracker-Tracking oder die Benutzer-Gateway-Sitzung.

Das Gateway kann ohne eigene Standortfreigabe und ohne geoeffnete Karte weiter
arbeiten. Die Erfassung eigener Teilnehmerfixes bleibt auf die aktive Karte
beschraenkt; diese Stufe ist noch kein Teilnehmer-Hintergrund-GPS-Tracking.
Beim Pausieren endet die eigene Freigabe, nicht zwangslaeufig das Gateway.
Ein Prozessneustart aktiviert keine Einwilligung automatisch. Eine neue Sitzung
verwirft noch ausstehende eigene Fixes der vorigen Standortfreigabe. Fremde
verschluesselte Meldungen koennen nach erneuter Online-Zulassung innerhalb
ihrer Gueltigkeit weiterlaufen.

## Sicherheits- und Zustellvertrag

- Maximal vier aktive Benutzergeraete pro Nutzer/Revier; die Serverzulassung
  endet ohne Erneuerung nach 15 Minuten.
- Signierte Revierverzeichnisse enthalten maximal 128 berechtigte Geraete und
  gelten zwei Minuten. Ohne frische Freigabe wird neue Funkannahme pausiert.
- Die Funkentdeckung sendet nur eine zufaellige Sitzungskennung. Weder GPS noch
  Benutzer-JWTs oder Hundeschluessel werden an ein anderes Geraet gegeben.
- Vor lokaler Speicherung werden Ursprungssignatur und Revier geprueft. Der
  Server prueft beim Upload erneut Mitgliedschaft, Widerruf und Jagdmodus.
- Teilnehmermeldungen sind `participant.location`, an Revier, Sequenz und
  Freigabekennung gebunden und hoechstens 90 Sekunden ab Messzeit gueltig.
  Revierloecher bleiben ausgeschlossen; es wird keine Historie nachgesendet.
- Eine alte Messzeit oder kleinere Sequenz ueberschreibt keine neuere Position.
  Das Ausschalten von Freigabe oder Jagdmodus invalidiert die Freigabekennung;
  alte Meldungen bleiben auch nach erneutem Einschalten ungueltig. Ohne Internet
  kann der Server einen lokalen Widerruf nicht sofort erfahren.
- Nachrichten-IDs sind lokal und serverseitig nach Ursprung getrennt. Position
  und Nachrichten-ID-Ledger werden atomar geschrieben. Gleiche IDs mit anderem
  Umschlag-Digest werden zurueckgewiesen.
- Serverbestaetigungen binden Revier, Ursprung, ID und exakten Umschlag-Digest.
  Erst nach Signaturpruefung ersetzt eine SQLite-Transaktion die Nachricht durch
  ihre Bestaetigung. Funkuebergabe allein gilt nicht als Zustellung.
- Ausdruecklich abgelehnte, abgelaufene und vom Nutzer widerrufene Meldungen
  werden nicht als zugestellt behandelt. Beim Stoppen wird die Gateway-Outbox
  geloescht; unbestaetigte Urspruenge behalten ihre Kopie.
- Hoechstens 500 Positionsmeldungen und 500 Bestaetigungen pro Gateway; maximal
  64 wartende Funkpakete. Es gibt nur einen Relay-Hop.
- Alte Hundemeldungen bleiben mit dem bisherigen verschluesselten Wire-Format
  kompatibel und duerfen ausserhalb des Reviers liegen. Die bisherige
  24-Stunden-Grenze bleibt fuer Hunde erhalten. Alte DogTracker-APKs verstehen
  neue signierte Rueckbestaetigungen allerdings noch nicht.

## Pruefung und Grenzen

```powershell
deno task test
deno check tools/generate-relay-keys.ts
```

Die SQL-Tests verwenden eingebettetes PostgreSQL (PGlite), lokale Rollen und
eine einfache PostGIS-Fixture. Sie pruefen Transaktionen, Grants, Widerruf,
Freigabesitzungen, Reihenfolge und Reviertrennung, ersetzen aber keine Abnahme
mit echtem Supabase-/PostGIS-Basisschema. HTTP-Tests simulieren Supabase;
Kryptografietests verwenden ausschliesslich kurzlebige Testschluessel.

Vor Produktion bleiben echte Rollen, verlorene Funkpakete und Serverantworten,
mehrere physische Geraete, Android-12/13/17-Berechtigungen, Energieverbrauch und
Offline-Widerruf zu pruefen. Fuer die Schluesselrotation gibt es noch keinen
automatischen Keyring-Migrationspfad.