import { globalScene } from "#app/global-scene";
import { coopSession } from "#system/coop-session";

/** What happened in one wave of a co-op run, for tuning the balance. */
export interface CoopWaveStat {
  wave: number;
  /** Whether the enemy side had a boss */
  boss: boolean;
  /** Turns the fight lasted */
  turns: number;
  /** How many of the players' Pokemon fainted during the wave */
  faints: number;
  /** Players' Pokemon that could still fight when the wave ended */
  alive: number;
  /** Average health left on the players' Pokemon, as a percentage */
  hpPercent: number;
  /** Money when the wave began */
  money: number;
  /** How the wave ended */
  result: "won" | "fled" | "wiped";
}

class CoopTelemetry {
  public readonly waves: CoopWaveStat[] = [];
  private startFainted = 0;
  private startMoney = 0;
  private startedWave = -1;

  /** A wave begins. */
  public startWave(): void {
    if (!coopSession.enabled) {
      return;
    }
    this.startedWave = globalScene.currentBattle.waveIndex;
    this.startFainted = globalScene.getPlayerParty().filter(p => p.isFainted()).length;
    this.startMoney = Math.floor(globalScene.money);
  }

  /** A wave ends (by a win, by fleeing, or by both teams being wiped). */
  public endWave(result: CoopWaveStat["result"]): void {
    if (!coopSession.enabled || globalScene.currentBattle.waveIndex !== this.startedWave) {
      return;
    }
    const party = globalScene.getPlayerParty();
    const hpPercent =
      party.length > 0
        ? Math.round((party.reduce((sum, p) => sum + p.hp / Math.max(1, p.getMaxHp()), 0) / party.length) * 100)
        : 0;
    const stat: CoopWaveStat = {
      wave: this.startedWave,
      boss: globalScene.getEnemyParty().some(p => p.isBoss()),
      turns: globalScene.currentBattle.turn,
      faints: Math.max(0, party.filter(p => p.isFainted()).length - this.startFainted),
      alive: party.filter(p => !p.isFainted()).length,
      hpPercent,
      money: this.startMoney,
      result,
    };
    // Rewinding to a snapshot plays a wave again: keep the latest try
    const again = this.waves.findIndex(w => w.wave === stat.wave);
    if (again !== -1) {
      this.waves.splice(again, 1);
    }
    this.waves.push(stat);
    this.startedWave = -1;
  }

  /** The run so far as CSV, ready to paste into a spreadsheet. */
  public toCsv(): string {
    const header = "wave,boss,turns,faints,alive,hpPercent,money,result";
    return [
      header,
      ...this.waves.map(w => [w.wave, w.boss, w.turns, w.faints, w.alive, w.hpPercent, w.money, w.result].join(",")),
    ].join("\n");
  }

  /** Print the run to the browser console and keep a copy in local storage (best effort). */
  public report(): void {
    if (this.waves.length === 0) {
      return;
    }
    console.table(this.waves);
    try {
      localStorage.setItem("coop_last_run", this.toCsv());
    } catch {
      // storage can be blocked: the console table is still there
    }
  }

  public clear(): void {
    this.waves.length = 0;
    this.startedWave = -1;
  }
}

export const coopTelemetry = new CoopTelemetry();

// In the browser console: `coopRunLog()` returns the CSV of this run, and `coopRunLog(true)` copies it
if (typeof window !== "undefined") {
  (window as unknown as { coopRunLog: (copy?: boolean) => string }).coopRunLog = (copy = false) => {
    const csv = coopTelemetry.toCsv();
    if (copy) {
      void navigator.clipboard?.writeText(csv);
    }
    return csv;
  };
}
