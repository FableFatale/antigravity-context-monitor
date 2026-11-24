<p align="center">
  <img src="../assets/logo.svg" width="64" height="64" alt="Context &amp; Cache Monitor Logo" />
</p>

<h1 align="center">Context &amp; Cache Monitor for Antigravity</h1>

<p align="center">
  Suivez l'occupation du contexte Gemini, l'efficacité du cache de préfixe et les compressions <code>CHECKPOINT</code> directement dans Google Antigravity — et déclenchez <code>/compact</code> avant les chutes de cache coûteuses.
</p>

<p align="center">
  <a href="../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>Français</b> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <sub>🤖 <b>Pour les agents IA &amp; LLM :</b> Passez la documentation humaine — lisez <a href="../llms.txt"><code>llms.txt</code></a> pour l'installation automatisée et les contrats d'API, et <a href="../AGENTS.md"><code>AGENTS.md</code></a> pour les invariants d'architecture.</sub>
</p>

---

## Pourquoi ce plugin ?

Lors de longues sessions Gemini dans Antigravity, le contexte s'accumule silencieusement jusqu'à déclencher une compression automatique `CHECKPOINT` ou provoquer une chute brutale du cache de préfixe, entraînant un recalcul complet coûteux. Antigravity n'offre nativement ni réglage local du seuil de compression, ni tableau de bord dédié à la santé du cache.

**Context & Cache Monitor** intègre observabilité et contrôle proactif directement dans Antigravity :

- **Application MCP plein écran (barre latérale gauche)** et **Tableau de bord Sidecar (panneau droit)** partageant une seule interface en temps réel.
- **Premier écran épuré** : une barre synthétique en haut affiche l'occupation actuelle de la session active, le repère d'alerte précoce et le seuil de compression — les réglages avancés restent rangés dans un tiroir latéral coulissant.
- **Seuils dynamiques par modèle** : analyse votre historique de `CHECKPOINT` et de pertes de cache pour recommander le seuil optimal par modèle. Un ajustement manuel ne s'applique qu'à la prochaine compression par défaut avant de revenir au mode adaptatif (verrouillage optionnel).
- **Architecture de cycle de vie du contexte en 3 couches** :
  1. **Délégation sous-agent en pré-alerte (seuil ≥70 %)** : le hook `PreInvocation` guide l'agent pour déléguer les recherches multi-fichiers et tests verbeux à `invoke_subagent`, préservant ainsi le cache de préfixe principal (>95 %).
  2. **Registre mémoire déterministe post-compaction (`CHECKPOINT`)** : dès le premier tour après une compression, le hook extrait en `<15 ms` la liste exacte des fichiers modifiés/lus et l'état des tâches pour éviter toute amnésie ou hallucination post-compaction.
  3. **Auto-Compact silencieux sans vol de focus** : envoie `/compact` uniquement lorsqu'Antigravity est au premier plan et le clavier/souris inactifs (double Entrée, déduplication par tour et ciblage UIAutomation).
- **Analyse unifiée & filtrage croisé** : basculez entre vue `24h` et `Heatmap 53 semaines` pleine largeur. Cliquez sur un modèle, une session (avec recherche globale) ou une tranche horaire pour filtrer tout le tableau de bord via des étiquettes amovibles en un clic.
- **5 langues auto-détectées** : s'adapte automatiquement à la langue du système (Français, English, 简体中文, 日本語, Deutsch).

---

## Démarrage rapide

### Option A · Installation par votre agent IA (Recommandé)

Envoyez simplement cette instruction à Antigravity (ou à tout agent de code) :

```text
Lis https://raw.githubusercontent.com/FableFatale/antigravity-context-monitor/main/llms.txt et installe le plugin Context & Cache Monitor dans mon dossier de plugins Antigravity.
```

### Option B · Installation manuelle

Prérequis : **Node.js `>= 20`** et **Google Antigravity**.

**Windows (PowerShell) :**

```powershell
git clone https://github.com/FableFatale/antigravity-context-monitor.git "$env:USERPROFILE\.gemini\config\plugins\context-monitor"
cd "$env:USERPROFILE\.gemini\config\plugins\context-monitor\mcp"
npm install
```

**macOS / Linux :**

```bash
git clone https://github.com/FableFatale/antigravity-context-monitor.git ~/.gemini/config/plugins/context-monitor
cd ~/.gemini/config/plugins/context-monitor/mcp
npm install
```

Ouvrez ensuite **Antigravity → Plugins / Customizations**, activez **Context & Cache Monitor**, puis ouvrez-le depuis :
- **Barre latérale gauche (Recommandé)** : cliquez sur **Context & Cache** pour la vue MCP App plein écran.
- **Panneau latéral droit** : sélectionnez **Context & Cache** via le menu `+`, ou saisissez `/context-monitor` dans le chat.

---

## Modes de compression

Ouvrez le tiroir **Paramètres** en haut à droite pour choisir le comportement au franchissement du seuil :

| Mode | Comportement | Plateforme |
| :--- | :--- | :--- |
| **Confirmation Toast** (`toast_confirm`) | Affiche une notification discrète en bas à droite sans voler le focus. Cliquez sur **Compresser** pour envoyer `/compact`, ou **+20K** pour différer. | Windows |
| **Compression automatique** (`ui_send`) | Attend que la session soit inactive, envoie `/compact` à la fenêtre Antigravity, puis restaure votre presse-papiers. | Windows |
| **Garde douce Hook** (`hook_guard`) | Affiche un bandeau 0-token via le hook `PreInvocation` et incite l'agent à conclure l'étape en cours avant compression. | Windows / macOS / Linux |
| **Blocage strict Hook** (`hook_block`) | Met en pause l'invocation suivante dès dépassement du seuil jusqu'à exécution de `/compact`. | Windows / macOS / Linux |
| **Notification seule** (`notify`) | Copie `/compact` dans le presse-papiers et vous alerte sans toucher aux fenêtres. | Windows / macOS / Linux |

---

## Confidentialité & Architecture

- **100 % local et en lecture seule** : aucune télémétrie, aucun appel réseau sortant. Lit les journaux locaux et métadonnées SQLite d'Antigravity en lecture seule ; les préférences sont enregistrées dans `plugin_data/context-monitor/auto-compact.json`.
- **Cœur unique sans dépendance** : un seul moteur Node.js (`sidecars/context-monitor/server.mjs`) alimente le Sidecar géré et le serveur MCP App (`mcp/server.mjs`), complété par le hook `PreInvocation` (`hooks/context-guard.mjs`).

Consultez [`llms.txt`](../llms.txt) et [`AGENTS.md`](../AGENTS.md) pour la cartographie complète, les contrats d'API et les conventions techniques.

---

## Licence

[MIT](../LICENSE) © 2026 FableFatale
