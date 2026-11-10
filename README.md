# Agenten-Dashboard

Plugin (Mod) für Claude Code, Desktop-App und Terminal, mit drei Teilen: Live-Dashboard für Haupt- und Subagenten, Gatekeeper für Modell und Aufwand der Subagenten und Planer für größere Aufgaben.

*English: A Claude Code mod with a live side panel for the main agent and subagents (model, effort, current tool call, plan progress), a gatekeeper that routes subagents to Haiku, Sonnet or the chat model by task type, and a planner prompt for larger tasks. The UI and prompts are in German.*

## Installation

```
/plugin install agenten-dashboard --marketplace VWdesignlab/agenten-dashboard
```

Danach `y` für das Hinzufügen des Marketplace und einen Geltungsbereich wählen, dann Claude Code neu starten. Voraussetzung: Claude Code mit Mod-Unterstützung (Hooks-Module), getestet mit Version 2.1.321.

Abschalten ohne Deinstallieren: `/gatekeeper aus` und `/planer aus`. Komplett entfernen: `/plugin uninstall agenten-dashboard`.

## 1. Live-Dashboard
Ein Bereich neben dem Chat, aufgebaut nach gängigen Regeln für Live-Dashboards (Gesamtstatus zuerst, Aktualität sichtbar, Status mit Zeichen und Wort, Erledigtes eingeklappt):

- **Kopf**: Gesamtstatus („Arbeitet · 3 Agenten aktiv“, „Wartet auf dich“, „Fertig“), Zahlen dieser Anfrage (aktiv, fertig, Fehler, laufende Aufrufe) und „Live · letzte Meldung vor …“.
- **Agenten-Karten**: je aktivem Agenten eine Karte mit Name, Modell, Auftrag und dem Schritt, der gerade läuft (▶, mit Dauer). Parallele Aufrufe einzeln. Zwischen Aufrufen „denkt nach (nach: …)“. Fragen an dich mit ⏳. Subagenten von Subagenten mit „↳ beauftragt von …“.
- **Erledigt**: beendete Subagenten als eine Zeile (Modell, Dauer, Aufrufe).
- **Plan**: Fortschrittsbalken, offene Aufgaben zuerst, höchstens fünf Zeilen.
- **Verlauf**: die letzten acht Meldungen, neueste zuerst.

Genauigkeit: Jeder Aufruf hat Start und Ende; die Uhr läuft jede Sekunde, solange gearbeitet wird; alle 3 s Abgleich mit der Agentenliste der Engine, damit kein beendeter Agent als aktiv hängen bleibt. Die Statuszeile zeigt den Schritt des gerade arbeitenden Agenten. `/agenten` öffnet das Dashboard wieder; ist es geschlossen, erinnert ein Hinweis unter dem Eingabefeld daran.

## 2. Gatekeeper (Modell und Aufwand für Subagenten)
Beim Start eines Subagenten ordnet der Gatekeeper die Aufgabe einem Bereich zu und setzt Modell und Aufwand (effort):

| Bereich | Beispiele | Modell | Aufwand |
|---|---|---|---|
| Nachschlagen | Dateien finden, auflisten, abschreiben, umformatieren | Haiku | mittel |
| Zuarbeit | recherchieren, Quellen zusammenfassen, viele Dokumente, nach Vorgabe erstellen | Sonnet (wenn der Chat auf Opus läuft), sonst Chat-Modell | Standard (Sonnet: hoch) |
| Urteil | planen, prüfen, bewerten, abwägen, Recht/Steuer/Vertrag, Endergebnis | Chat-Modell | mindestens hoch |

- Planen/Prüfen/Bewerten und ähnliche Schlüsselwörter führen ohne Einstufung direkt zu „Urteil“. Sonst stuft Haiku die Aufgabe ein (kurzer Aufruf über dein Kontingent).
- Haiku-Aufträge bekommen das heutige Datum und die Anweisung, nachzusuchen, vollständig abzuarbeiten, zu prüfen und Lücken zu nennen (gleicht bekannte Haiku-Schwächen aus).
- Ein vom Hauptagenten ausdrücklich gesetztes Modell gilt immer (so kann er hochstufen). Bei unklarer oder fehlgeschlagener Einstufung bleibt alles beim Chat-Modell.
- Aufgaben, die etwas löschen, überschreiben, verschieben, umbenennen, zurücksetzen, migrieren, deployen oder veröffentlichen, gehen nie an Haiku, sondern mindestens an die Zuarbeit-Stufe.
- Ist ein Befehlsname (`/agenten`, `/gatekeeper`, `/planer`) bei dir schon vergeben, etwa durch einen eigenen Skill, erscheint dieser Befehl womöglich nicht in der Befehlsliste. Die Mod startet trotzdem vollständig.
- **Verstärkung**: Läuft ein herabgestufter Subagent dreimal hintereinander auf Fehler, nimmt er für die nächsten vier Denkschritte das stärkere Modell des Chats und fällt danach auf sein günstiges Modell zurück. Das Dashboard zeigt es im Verlauf und beim Modell der Karte.
- Der Hauptagent selbst wird nicht verändert: Modell und Aufwand wählst du in der App.

Befehl: `/gatekeeper normal | qualitaet | aus`. „qualitaet“: Nachschlagen nie auf Haiku (Sonnet, wenn der Chat auf Opus läuft, sonst Chat-Modell), Zuarbeit auf dem Chat-Modell.

Grundlage: Anthropic-Dokumentation „Choosing the right model“, „Effort“ und „Optimizing for cost and intelligence“ (Stand November 2026).

## 3. Planer
Gibt Claude für größere Aufgaben (ab drei getrennten Schritten, mehreren Ergebnissen oder Recherche plus Erstellung) ein festes Vorgehen: erkunden → Plan in der Aufgabenliste mit „Fertig wenn“, Rolle und Abhängigkeiten → umsetzen → unabhängige Prüfung durch einen eigenen Subagenten mit selbst erstellter Ja/Nein-Checkliste (jedes Ja mit Beleg, ein Nein genügt für „Mängel“, vorher Widerlegungsversuch; höchstens zwei Korrekturrunden). Kleinere Aufgaben bleiben schlank. Befehl: `/planer an | aus`.

## Vergleich mit ähnlichen Projekten (Stand November 2026)

- **Dashboards:** Andere Lösungen laufen als eigener Server mit Browser-Oberfläche (z. B. disler/claude-code-hooks-multi-agent-observability, simple10/agents-observe, Claude-Code-Agent-Monitor) oder als Statuszeile (z. B. jarrodwatts/claude-hud). Dieses Plugin läuft ohne Server direkt neben dem Chat und zeigt zusätzlich Aufwand (effort) und Plan-Fortschritt je Agent. Kosten und Tokens zeigt es nicht.
- **Modell-Routing:** Viele Ansätze routen nur per Hinweis im Systemprompt. Dieses Plugin setzt Modell und Aufwand direkt beim Start des Subagenten, damit es auch wirklich gilt. Benchmarks zu LLM-Routern (z. B. LLMRouterBench, arXiv 2601.07206) zeigen abnehmenden Nutzen größerer Modell-Sätze; eine sorgfältige Auswahl weniger Modelle zählt mehr. Deshalb gibt es nur drei Bereiche, und im Zweifel bleibt das Chat-Modell. Ob das Routing bei Claude-Code-Subagenten Qualität und Kosten verbessert, ist nicht gemessen.
- **Planen und Prüfen:** Folgt den Claude-Code-Best-Practices (erkunden, planen, umsetzen, prüfen) und der Checklisten-Forschung (TICK: Ja/Nein-Fragen einzeln beantworten).

Einstellungen gelten für alle künftigen Chats. Das Plugin sendet keine Daten nach außen; die Einstufung im Gatekeeper ist ein kurzer Haiku-Aufruf über dein Konto.
