/**
 * UI controller (ROADMAP Phase 4): owns the DOM screens (menu / settings /
 * match end / pause overlay), binds the settings inputs, renders the career
 * panel, and computes the XP flow at match end. Pure DOM — game systems are
 * reached through the callbacks main.ts supplies.
 */
import type { Profile } from "./save";
import { exportSave, importSave, loadProfile, saveProfile } from "./save";
import type { Telemetry } from "../telemetry/telemetry";
import { levelForXp, levelProgress, matchXp, rankName } from "./progression";
import { QUALITY_SCALE, loadSettings, type KVStore, type Settings } from "./settings";
import type { AudioView } from "../view/audio";

export type ScreenName = "menu" | "settings" | "none" | "matchend" | "pause";

export interface MatchEndResult {
  won: boolean;
  mode: string;
  map: string;
  kills: number;
  deaths: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  /** Per-weapon accuracy, indexed by slot (label derived from the id). */
  weaponAcc: { id: string; fired: number; hit: number }[];
  /** Blue and red team totals (TDM) or top score (FFA) for the summary line. */
  summary: string;
}

export interface UiDeps {
  store: KVStore;
  audio: AudioView;
  settings: Settings;
  telemetry: Telemetry;  profile: Profile;
  /** Start a fresh match (called from the PLAY / NEXT MAP buttons). */
  startMatch(): void;
  /** Abandon the current match and return to the menu. */
  quitToMenu(): void;
  /** Called on every settings change (live-apply). */
  applySettings(s: Settings): void;
}

export class Ui {
  private readonly d: UiDeps;
  private screen: ScreenName = "menu";
  /** Where DONE returns to (settings can open from menu or pause). */
  private settingsReturn: "menu" | "pause" = "menu";

  private toastTimer = 0;

  private readonly el = {
    menu: document.querySelector<HTMLElement>("#menu")!,
    toast: document.querySelector<HTMLElement>("#toast")!,
    settings: document.querySelector<HTMLElement>("#settings-screen")!,
    matchend: document.querySelector<HTMLElement>("#matchend")!,
    overlay: document.querySelector<HTMLElement>("#overlay")!,
    overlayHint: document.querySelector<HTMLElement>("#overlay-hint")!,
    overlayQuit: document.querySelector<HTMLElement>("#overlay-quit")!,
    career: document.querySelector<HTMLElement>("#career")!,
    sessionPanel: document.querySelector<HTMLElement>("#session-panel")!,
    btnPlay: document.querySelector<HTMLButtonElement>("#btn-play")!,
    btnSettings: document.querySelector<HTMLButtonElement>("#btn-settings")!,
    btnReset: document.querySelector<HTMLButtonElement>("#btn-reset")!,
    btnSettingsBack: document.querySelector<HTMLButtonElement>("#btn-settings-back")!,
    meTitle: document.querySelector<HTMLElement>("#me-title")!,
    mePanel: document.querySelector<HTMLElement>("#me-panel")!,
    btnAgain: document.querySelector<HTMLButtonElement>("#btn-again")!,
    btnMenu: document.querySelector<HTMLButtonElement>("#btn-menu")!,
    hudFps: document.querySelector<HTMLElement>("#hud-fps")!,
    set: {
      fov: document.querySelector<HTMLInputElement>("#set-fov")!,
      sens: document.querySelector<HTMLInputElement>("#set-sens")!,
      res: document.querySelector<HTMLInputElement>("#set-res")!,
      quality: document.querySelector<HTMLSelectElement>("#set-quality")!,
      fps: document.querySelector<HTMLInputElement>("#set-fps")!,
      invertY: document.querySelector<HTMLInputElement>("#set-inverty")!,
      master: document.querySelector<HTMLInputElement>("#set-master")!,
      sfx: document.querySelector<HTMLInputElement>("#set-sfx")!,
      outFov: document.querySelector<HTMLElement>("#out-fov")!,
      outSens: document.querySelector<HTMLElement>("#out-sens")!,
      outRes: document.querySelector<HTMLElement>("#out-res")!,
      outMaster: document.querySelector<HTMLElement>("#out-master")!,
      outSfx: document.querySelector<HTMLElement>("#out-sfx")!,
    },
    saveExport: document.querySelector<HTMLButtonElement>("#btn-save-export")!,
    saveImport: document.querySelector<HTMLButtonElement>("#btn-save-import")!,
    saveBlob: document.querySelector<HTMLTextAreaElement>("#save-blob")!,
    saveStatus: document.querySelector<HTMLElement>("#save-status")!,
  };

  constructor(deps: UiDeps) {
    this.d = deps;
    this.bindButtons();
    this.bindSettings();
    this.showScreen("menu");
    this.renderCareer();
  }

  get current(): ScreenName {
    return this.screen;
  }

  /** True while any match-blocking UI is up (main loop pauses the world). */
  get blocksMatch(): boolean {
    return this.screen !== "none";
  }

  showScreen(name: ScreenName): void {
    this.screen = name;
    this.el.menu.classList.toggle("open", name === "menu");
    this.el.settings.classList.toggle("open", name === "settings");
    this.el.matchend.classList.toggle("open", name === "matchend");
    // The overlay is ONLY the pause screen now. Playing state ("none") must
    // not put a full-screen layer over the canvas: if pointer lock fails,
    // that layer previously trapped the player on a dead click-to-play
    // screen (the "black page" bug). Pauses now come from Esc / focus loss.
    const overlayUp = name === "pause";
    this.el.overlay.style.display = overlayUp ? "flex" : "none";
    this.el.overlayQuit.style.display = overlayUp ? "block" : "none";
    this.el.overlayHint.textContent = overlayUp ? "Paused — click to resume" : "";
  }

  /** Small non-blocking notice above the HUD (auto-hides in 4 s). */
  toast(message: string): void {
    this.el.toast.textContent = message;
    this.el.toast.classList.add("show");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.el.toast.classList.remove("show");
    }, 4000);
  }

  /** Re-sync the settings controls from the settings object (auto-quality). */
  syncSettings(): void {
    const s = this.d.settings;
    this.el.set.res.value = String(s.resolutionScale);
    this.el.set.quality.value = s.quality;
    this.el.set.outRes.textContent = `${Math.round(s.resolutionScale * 100)}%`;
  }

  renderCareer(): void {
    // Session dashboard (Phase 6): last-20-matches aggregates + perf.
    const t = this.d.telemetry.aggregate();
    const acc = Math.round(t.acc * 100);
    const modeRow = t.byMode
      .map((m) => `${m.mode.toUpperCase()} ${m.wins}/${m.matches}`)
      .join(" · ");
    this.el.sessionPanel.innerHTML =
      `<div class="title">SESSION${t.matches > 0 ? ` — ${t.matches} match${t.matches === 1 ? "" : "es"}` : ""}</div>` +
      (t.matches === 0
        ? `<div>No matches yet this session.</div>`
        : `<div>Win rate ${Math.round(t.winRate * 100)}% · K/D ${t.kd.toFixed(2)} · Acc ${acc}%</div>` +
          (modeRow ? `<div>${modeRow}</div>` : "") +
          `<div>FPS avg ${t.avgFps.toFixed(0)} · min ${t.minFps.toFixed(0)}</div>`);

    const p = this.d.profile;
    const level = levelForXp(p.xp);
    const prog = levelProgress(p.xp);
    const careerAcc = p.career.shotsFired > 0 ? Math.round((p.career.shotsHit / p.career.shotsFired) * 100) : 0;
    const kd = p.career.deaths > 0 ? (p.career.kills / p.career.deaths).toFixed(2) : p.career.kills.toFixed(2);
    this.el.career.innerHTML =
      `<div class="rank">Level ${level} · ${rankName(level)}</div>` +
      `<div class="xpbar"><div class="xpfill" style="width:${Math.round((prog.into / prog.span) * 100)}%"></div></div>` +
      `<div>${prog.into} / ${prog.span} XP</div>` +
      `<div class="grid">` +
      `<span>Matches ${p.career.matches}</span><span>Wins ${p.career.wins}</span>` +
      `<span>Kills ${p.career.kills}</span><span>Deaths ${p.career.deaths}</span>` +
      `<span>K/D ${kd}</span><span>Accuracy ${careerAcc}%</span>` +
      `</div>`;
  }

  /** Compute XP, persist the profile, and show the match-end screen. */
  showMatchEnd(r: MatchEndResult): void {
    const award = matchXp({ kills: r.kills, deaths: r.deaths, won: r.won });
    const p = this.d.profile;
    const beforeLevel = levelForXp(p.xp);
    p.xp += award.total;
    p.career.matches += 1;
    if (r.won) p.career.wins += 1;
    p.career.kills += r.kills;
    p.career.deaths += r.deaths;
    p.career.headshots += r.headshots;
    p.career.shotsFired += r.shotsFired;
    p.career.shotsHit += r.shotsHit;
    saveProfile(this.d.store, p);
    const afterLevel = levelForXp(p.xp);
    const leveledUp = afterLevel > beforeLevel;

    this.el.meTitle.textContent = r.won ? "VICTORY" : "DEFEAT";
    this.el.meTitle.classList.toggle("won", r.won);
    this.el.meTitle.classList.toggle("lost", !r.won);
    const acc = r.shotsFired > 0 ? Math.round((r.shotsHit / r.shotsFired) * 100) : 0;
    const prog = levelProgress(p.xp);
    // Per-weapon accuracy rows, most-used first (Phase 5 telemetry).
    const weaponRows = r.weaponAcc
      .filter((wp) => wp.fired > 0)
      .sort((a, b) => b.fired - a.fired)
      .slice(0, 4)
      .map((wp) => {
        const label = wp.id.charAt(0).toUpperCase() + wp.id.slice(1);
        const wacc = Math.round((wp.hit / wp.fired) * 100);
        return `<div class="xprow"><span>${label} ${wp.hit}/${wp.fired}</span><span>${wacc}%</span></div>`;
      })
      .join("");
    this.el.mePanel.innerHTML =
      `<div>${r.mode.toUpperCase()} on ${r.map} — ${r.summary}</div>` +
      (weaponRows ? `<div class="xprow weapons">${weaponRows}</div>` : "") +
      `<div class="xprow"><span>Kills ${r.kills} × 20</span><span>+${award.kills}</span></div>` +
      `<div class="xprow"><span>Win bonus</span><span>+${award.win}</span></div>` +
      `<div class="xprow"><span>Net score (${Math.max(0, r.kills - r.deaths)} × 10)</span><span>+${award.net}</span></div>` +
      `<div class="xprow total"><span>K/D ${r.kills}/${r.deaths} · HS ${r.headshots} · Acc ${acc}%</span><span>+${award.total} XP</span></div>` +
      (leveledUp
        ? `<div class="lvl" style="color:#ff6b35">LEVEL UP — ${afterLevel} · ${rankName(afterLevel)}</div>`
        : `<div class="lvl">Level ${afterLevel} · ${rankName(afterLevel)}</div>`) +
      `<div class="xpbar"><div class="xpfill" style="width:${Math.round((prog.into / prog.span) * 100)}%"></div></div>` +
      `<div class="xprow"><span>${prog.into} / ${prog.span} to next level</span><span>${p.xp} total</span></div>`;
    this.showScreen("matchend");
    this.d.audio.matchEnd(r.won);
  }

  private bindButtons(): void {
    this.el.btnPlay.addEventListener("click", () => {
      this.d.audio.unlock();
      this.d.audio.uiClick();
      this.d.startMatch();
    });
    this.el.btnAgain.addEventListener("click", () => {
      this.d.audio.unlock();
      this.d.audio.uiClick();
      this.d.startMatch();
    });
    this.el.btnSettings.addEventListener("click", () => {
      this.settingsReturn = "menu";
      this.d.audio.uiClick();
      this.showScreen("settings");
    });
    this.el.btnSettingsBack.addEventListener("click", () => {
      this.d.audio.uiClick();
      this.showScreen(this.settingsReturn === "pause" ? "pause" : "menu");
      this.renderCareer();
    });
    this.el.btnMenu.addEventListener("click", () => {
      this.d.audio.uiClick();
      this.d.quitToMenu();
    });
    this.el.btnReset.addEventListener("click", () => {
      // Two-step confirm inline (no window.confirm in some sandboxes).
      if (this.el.btnReset.dataset.armed !== "1") {
        this.el.btnReset.dataset.armed = "1";
        this.el.btnReset.textContent = "REALLY RESET?";
        window.setTimeout(() => {
          this.el.btnReset.dataset.armed = "0";
          this.el.btnReset.textContent = "RESET CAREER";
        }, 3000);
        return;
      }
      this.el.btnReset.dataset.armed = "0";
      this.el.btnReset.textContent = "RESET CAREER";
      this.d.store.removeItem("strikepoint.profile.v1");
      this.d.profile.xp = 0;
      this.d.profile.career = {
        matches: 0, wins: 0, kills: 0, deaths: 0, headshots: 0, shotsFired: 0, shotsHit: 0,
      };
      saveProfile(this.d.store, this.d.profile);
      this.renderCareer();
      this.d.audio.uiClick();
    });
    this.el.overlayQuit.addEventListener("click", (e) => {
      e.stopPropagation();
      this.d.quitToMenu();
    });

    // --- Portable save bridge (Phase 6) ---
    this.el.saveExport.addEventListener("click", () => {
      this.el.saveBlob.value = exportSave(this.d.store);
      this.el.saveStatus.textContent = "Copied to the box — store it somewhere safe.";
      this.el.saveStatus.classList.remove("err");
      this.d.audio.uiClick();
    });
    this.el.saveImport.addEventListener("click", () => {
      const ok = importSave(this.d.store, this.el.saveBlob.value);
      if (ok) {
        // Reload the live objects from the restored blob. `settings` is
        // the shared object all systems hold by reference, so it must be
        // mutated in place rather than reassigned.
        const freshSettings = loadSettings(this.d.store);
        Object.assign(this.d.settings, freshSettings);
        this.d.applySettings(this.d.settings);
        const fresh = loadProfile(this.d.store);
        this.d.profile.xp = fresh.xp;
        this.d.profile.career = fresh.career;
        this.renderCareer();
        this.bindSettingsSync();
        this.el.saveStatus.textContent = "Save imported.";
        this.el.saveStatus.classList.remove("err");
      } else {
        this.el.saveStatus.textContent = "Not a valid Strikepoint save.";
        this.el.saveStatus.classList.add("err");
      }
      this.d.audio.uiClick();
    });
  }

  /** Re-read controls from the (possibly re-imported) settings object. */
  private bindSettingsSync(): void {
    const s = this.d.settings;
    this.el.set.fov.value = String(s.fov);
    this.el.set.sens.value = String(s.sensitivity);
    this.el.set.res.value = String(s.resolutionScale);
    this.el.set.quality.value = s.quality;
    this.el.set.fps.checked = s.showFps;
    this.el.set.invertY.checked = s.invertY;
    this.el.set.master.value = String(s.masterVolume);
    this.el.set.sfx.value = String(s.sfxVolume);
    this.el.set.outFov.textContent = String(Math.round(s.fov));
    this.el.set.outSens.textContent = s.sensitivity.toFixed(2);
    this.el.set.outRes.textContent = `${Math.round(s.resolutionScale * 100)}%`;
  }

  private bindSettings(): void {
    const s = this.d.settings;
    const sync = (): void => {
      this.el.set.fov.value = String(s.fov);
      this.el.set.sens.value = String(s.sensitivity);
      this.el.set.res.value = String(s.resolutionScale);
      this.el.set.quality.value = s.quality;
      this.el.set.fps.checked = s.showFps;
      this.el.set.invertY.checked = s.invertY;
      this.el.set.master.value = String(s.masterVolume);
      this.el.set.sfx.value = String(s.sfxVolume);
      this.el.set.outFov.textContent = String(Math.round(s.fov));
      this.el.set.outSens.textContent = s.sensitivity.toFixed(2);
      this.el.set.outRes.textContent = `${Math.round(s.resolutionScale * 100)}%`;
      this.el.set.outMaster.textContent = `${Math.round(s.masterVolume * 100)}%`;
      this.el.set.outSfx.textContent = `${Math.round(s.sfxVolume * 100)}%`;
      this.el.hudFps.style.visibility = s.showFps ? "visible" : "hidden";
    };
    sync();

    const change = (): void => {
      s.fov = Number(this.el.set.fov.value);
      s.sensitivity = Number(this.el.set.sens.value);
      // Quality preset drives the resolution scale; the slider refines it.
      if (this.el.set.quality.value !== s.quality) {
        s.quality = this.el.set.quality.value as Settings["quality"];
        s.resolutionScale = QUALITY_SCALE[s.quality];
      } else {
        s.resolutionScale = Number(this.el.set.res.value);
      }
      s.showFps = this.el.set.fps.checked;
      s.invertY = this.el.set.invertY.checked;
      s.masterVolume = Number(this.el.set.master.value);
      s.sfxVolume = Number(this.el.set.sfx.value);
      sync();
      this.d.applySettings(s);
      this.d.audio.applySettings(s);
    };
    for (const input of [
      this.el.set.fov, this.el.set.sens, this.el.set.res, this.el.set.master, this.el.set.sfx,
    ]) {
      input.addEventListener("input", change);
    }
    for (const input of [this.el.set.fps, this.el.set.invertY, this.el.set.quality]) {
      input.addEventListener("change", change);
    }
  }
}
