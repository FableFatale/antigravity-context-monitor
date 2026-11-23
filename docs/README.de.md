<p align="center">
  <img src="../assets/logo.svg" width="64" height="64" alt="Context &amp; Cache Monitor Logo" />
</p>

<h1 align="center">Context &amp; Cache Monitor for Antigravity</h1>

<p align="center">
  Behalten Sie Gemini-Kontextauslastung, Prefix-Cache-Trefferquote und <code>CHECKPOINT</code>-Komprimierungen direkt in Google Antigravity im Blick — und lösen Sie <code>/compact</code> rechtzeitig aus, bevor teure Cache-Misses entstehen.
</p>

<p align="center">
  <a href="../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <b>Deutsch</b>
</p>

<p align="center">
  <sub>🤖 <b>Für KI-Agenten &amp; LLMs:</b> Überspringen Sie die Dokumentation für Menschen — lesen Sie <a href="../llms.txt"><code>llms.txt</code></a> für maschinenlesbare Installationsschritte &amp; API-Verträge sowie <a href="../AGENTS.md"><code>AGENTS.md</code></a> für Architektur-Invarianten.</sub>
</p>

---

## Warum dieses Plugin?

In längeren Gemini-Sitzungen wächst der Kontext in Antigravity unbemerkt an, bis entweder eine automatische `CHECKPOINT`-Komprimierung greift oder der Prefix-Cache wegbricht und teure Neuberechnungen erzwingt. Antigravity bietet von Haus aus weder einen lokalen Schwellenwert-Schalter noch ein Dashboard zur Cache-Analyse.

**Context & Cache Monitor** bringt volle Transparenz und ruhige, proaktive Steuerung nativ in Antigravity:

- **Vollbild-MCP-App (linke Seitenleiste)** und **Sidecar-Dashboard (rechter Bereich)** auf Basis einer gemeinsamen Live-Oberfläche.
- **Aufgeräumte Startansicht**: Eine kompakte Statusleiste oben zeigt aktuelle Kontextauslastung, Frühwarnmarke und Komprimierungsschwelle der aktiven Sitzung — seltener genutzte Einstellungen ruhen sauber in einem seitlichen Drawer.
- **Dynamische Schwellenwerte pro Modell**: Lernt aus vergangenen `CHECKPOINT`-Ereignissen und Cache-Einbrüchen, um je Modell den passenden Schwellenwert vorzuschlagen. Manuelle Anpassungen gelten standardmäßig einmalig für die nächste Komprimierung und kehren danach in den Automatikmodus zurück (optional sperrbar).
- **Interaktive Analyse & Cross-Filtering**: Wechseln Sie zwischen `24h-Stundenansicht` und vollbreiter `53-Wochen-Heatmap`. Ein Klick auf ein Modell, eine Sitzung (inkl. Volltextsuche) oder eine Stunde filtert das gesamte Dashboard über klar sichtbare Filter-Chips in der Kopfleiste.
- **5 Komprimierungsstrategien**: Fokusfreundliche Desktop-Toast-Bestätigung, automatisches `/compact` im Leerlauf oder plattformübergreifende `PreInvocation`-Hooks.

---

## Schnellstart

### Option A · Installation durch Ihren KI-Agenten (Empfohlen)

Geben Sie diesen Prompt direkt in Antigravity (oder einem beliebigen Coding-Agenten) ein:

```text
Lies https://raw.githubusercontent.com/FableFatale/antigravity-context-monitor/main/llms.txt und installiere das Plugin Context & Cache Monitor in mein lokales Antigravity-Plugin-Verzeichnis.
```

### Option B · Manuelle Installation

Voraussetzungen: **Node.js `>= 20`** und **Google Antigravity**.

**Windows (PowerShell):**

```powershell
git clone https://github.com/FableFatale/antigravity-context-monitor.git "$env:USERPROFILE\.gemini\config\plugins\context-monitor"
cd "$env:USERPROFILE\.gemini\config\plugins\context-monitor\mcp"
npm install
```

**macOS / Linux:**

```bash
git clone https://github.com/FableFatale/antigravity-context-monitor.git ~/.gemini/config/plugins/context-monitor
cd ~/.gemini/config/plugins/context-monitor/mcp
npm install
```

Aktivieren Sie anschließend **Context & Cache Monitor** unter **Antigravity → Plugins / Customizations**:
- **Linke Seitenleiste (Empfohlen)**: Klicken Sie auf **Context & Cache** für die Vollbild-MCP-App.
- **Rechter Bereich**: Öffnen Sie **Context & Cache** über das `+`-Menü oder geben Sie `/context-monitor` im Chat ein.

---

## Komprimierungsmodi

Über den **Einstellungen**-Drawer oben rechts bestimmen Sie das Verhalten beim Erreichen des Schwellenwerts:

| Modus | Verhalten | Plattform |
| :--- | :--- | :--- |
| **Desktop-Toast-Bestätigung** (`toast_confirm`) | Blendet unten rechts einen unaufdringlichen Toast ohne Fokusverlust ein. Ein Klick auf **Komprimieren** sendet `/compact`, **+20K** verschiebt einmalig. | Windows |
| **Vollautomatik im Leerlauf** (`ui_send`) | Wartet die konfigurierte Leerlaufzeit ab, sendet `/compact` an das Antigravity-Fenster und stellt danach die Zwischenablage wieder her. | Windows |
| **Hook-Hinweisschutz** (`hook_guard`) | Zeigt über den `PreInvocation`-Hook einen 0-Token-Hinweis im Chat und regt den Agenten zum sauberen Abschluss vor der Komprimierung an. | Windows / macOS / Linux |
| **Hook-Blockade** (`hook_block`) | Pausiert den nächsten Modellaufruf nach Überschreiten der Schwelle, bis `/compact` ausgeführt wurde. | Windows / macOS / Linux |
| **Nur Hinweis** (`notify`) | Kopiert `/compact` in die Zwischenablage und benachrichtigt Sie ohne Fensterinteraktion. | Windows / macOS / Linux |

---

## Datenschutz & Architektur

- **100 % lokal & schreibgeschützt**: Keine Telemetrie, keine externen Netzwerkanfragen. Liest lokale Antigravity-Sitzungsprotokolle und SQLite-Metadaten strikt schreibgeschützt; Konfigurationen liegen ausschließlich in `plugin_data/context-monitor/auto-compact.json`.
- **Schlanker Einzelkern**: Eine abhängigkeitsfreie Node.js-Engine (`sidecars/context-monitor/server.mjs`) speist sowohl den verwalteten Sidecar als auch den MCP-App-Server (`mcp/server.mjs`), ergänzt durch den `PreInvocation`-Hook (`hooks/context-guard.mjs`).

Vollständige Dateikarte, API-Verträge und Architekturregeln finden sich in [`llms.txt`](../llms.txt) und [`AGENTS.md`](../AGENTS.md).

---

## Lizenz

[MIT](../LICENSE) © 2026 FableFatale
