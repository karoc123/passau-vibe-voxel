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

## Vision (Server-Welt, GTA-artig)

5. **Server-Technik:** Gibt es eine Vorliebe für die Sprache des Servers (TypeScript/Node, damit Code mit dem Client geteilt wird, oder Rust/Go für Leistung)? *Empfehlung aus dem Fundament-Plan: TypeScript. Physik (Rapier), Mesher und Kollision laufen schon ohne Browser in Node; Rust würde den Kern doppelt pflegen.*
6. **Feinere Blöcke:** Wie fein soll die Nahansicht werden: 50 cm, 25 cm oder noch feiner? Überall oder nur dort, wo gebaut bzw. detailliert wird? *Empfehlung: Die 1-m-Welt bleibt. Einzelne 1-m-Zellen lassen sich bei Bedarf fein unterteilen, etwa in 4×4×4 oder 8×8×8 kleinere Blöcke. So bleiben Fernansicht und Datenmenge unverändert.*
7. **Spielerbauten:** Darf ein Spieler überall bauen, oder nur auf eigenen Grundstücken? Dürfen Spieler bestehende (importierte) Gebäude umbauen oder abreißen, dauerhaft?
8. **Zerstörung:** Wann setzt sich Zerstörung zurück: erst beim Neuladen des Chunks, nach einer festen Zeit oder wenn kein Spieler in der Nähe ist? Sehen alle Spieler dieselben Trümmer?
9. **Spielerzahl:** Wie viele Spieler sollen gleichzeitig auf einer Welt sein (10, 100, 1000)? Davon hängt die Server-Architektur stark ab.

Weitere Fragen aus dem Fundament-Plan kommen hier dazu.
