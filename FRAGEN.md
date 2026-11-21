# Offene Fragen

Fragen an dich, ohne Eile. Antworten einfach direkt darunter schreiben oder im Chat nennen.
Erledigte Fragen werden gestrichen bzw. entfernt.

## Projekt heute

1. **Quellenzeile:** Sollen iNaturalist (Baumarten-Beobachtungen) und die Bundeswaldinventur (BWI) in die Quellen-/Credits-Zeile im Viewer, oder reicht die README?
2. **Mobil-Test:** Die Änderungen sind drin: Sprungknopf im Querformat, Pinch-Zoom beim Fahren und in der Drohne, Totzone des Sticks. Hast du sie auf dem Handy ausprobiert, und passt das Gefühl?
3. **Beschriftung Grubweg:** Sie sitzt 10 m vor dem Ostrand der Karte. Soll sie 100–200 m nach Westen rücken, oder ist sie so gut sichtbar?
4. **Innenräume Phase 2:** Wenn die Engine-Vorbereitung fertig ist: Welches Gebäude soll zuerst ein Inneres bekommen (Dom?), und sollen Durchfahrten/Durchgänge zuerst kommen?
5a. **Krater-Test (`?dig=1`):** Ein Klick sprengt einen Krater mit 3 m Radius. Nach dem Neuladen ist er wieder weg. Bitte bei Gelegenheit prüfen:
    - Kein Flackern.
    - An Kachelkanten keine Naht.
    - Bäume und Gras im Loch verschwinden mit.
    - Auto und Drohne fallen ins Loch.
    - Nach dem Neuladen ist das Loch weg.
    - In der Konsole stehen die Zeiten.
    - Wiederholte Klicks auf dieselbe Kachel sind schneller als der erste.
    - An den 16-m-Linien keine Risse, keine fehlenden Flächen und keine Helligkeitssprünge, vor allem an schrägen Fassaden, Dachkanten und Rampen.

## Vision (Server-Welt, GTA-artig)

5. **Server-Technik:** Gibt es eine Vorliebe für die Sprache des Servers (TypeScript/Node, damit Code mit dem Client geteilt wird, oder Rust/Go für Leistung)? *Empfehlung aus dem Fundament-Plan: TypeScript. Physik (Rapier), Mesher und Kollision laufen schon ohne Browser in Node; Rust würde den Kern doppelt pflegen.*
6. **Feinere Blöcke:** Wie fein soll die Nahansicht werden: 50 cm, 25 cm oder noch feiner? Überall oder nur dort, wo gebaut bzw. detailliert wird? *Empfehlung: Die 1-m-Welt bleibt. Einzelne 1-m-Zellen lassen sich bei Bedarf fein unterteilen, etwa in 4×4×4 oder 8×8×8 kleinere Blöcke. So bleiben Fernansicht und Datenmenge unverändert.*
7. **Spielerbauten:** Darf ein Spieler überall bauen, oder nur auf eigenen Grundstücken? Dürfen Spieler bestehende (importierte) Gebäude umbauen oder abreißen, dauerhaft?
8. **Zerstörung:** Wann setzt sich Zerstörung zurück: erst beim Neuladen des Chunks, nach einer festen Zeit oder wenn kein Spieler in der Nähe ist? Sehen alle Spieler dieselben Trümmer?
9. **Spielerzahl:** Wie viele Spieler sollen gleichzeitig auf einer Welt sein (10, 100, 1000)? Davon hängt die Server-Architektur stark ab.

## Umbau „Schrägen als Daten“ (Plan: docs/plans/surface-caps.md)

Bis du antwortest, setze ich jeweils die Empfehlung um.

10. **Wiesen und Felder:** Sollen nur Straßen und Brücken glatte Oberflächen bekommen, während Wiesen und Felder 1-m-Stufen bleiben (auch für das Auto, das dort dann leicht holpert)? *Empfehlung: ja. Glatte Wiesen kosten später ein eigenes, größeres Datenformat (etwa +16 MB).*
11. **Dächer:** Sollen die Dachschrägen gleich nach den Straßen ebenfalls auf die neuen Daten umgestellt werden, oder vorerst nicht? *Die Daten dafür entstehen im selben Neubau. Empfehlung: erst Straßen fertig, dann anhand von Bildern entscheiden.*
12. **Bauen auf Schrägen:** Wenn ein Spieler eine schräge Straßenzelle nur umfärbt, soll sie schräg bleiben? Ein Abriss oder Krater macht sie ohnehin eckig. *Empfehlung: ja, das ist die einfache Regel.*
13. **Glättung:** Lieber ruhiger fahren oder näher am vermessenen Gelände? *Empfehlung: zuerst der Standard, später in Minuten änderbar.*
14. **Drohne:** *Entschieden: Die Drohne stößt vorerst weiter an die Würfel. In einem späteren Schritt bekommt sie die gemeinsamen Höhen (Straßen, Brücken, nach der Dachumstellung auch Dächer).*
15. **Neubau der ganzen Karte (etwa 1 Stunde):** Wann darf er laufen? Er nimmt auch Lärchen, Schaldinger Pfeiler und Laternen mit.

Weitere Fragen aus dem Fundament-Plan kommen hier dazu.
