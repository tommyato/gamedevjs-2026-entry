/**
 * Tommyato (own-droplet) implementation of `IPlatformServices`.
 *
 * Phase 1 stub — every method throws. Phase 3 will fill in:
 *   - localStorage saves / achievements / stats (with a one-shot username prompt)
 *   - HTTP leaderboards against api.tommyato.com (SQLite-backed)
 *   - Colyseus client → IMultiplayerTransport shim that emits PeerMessage callbacks
 *
 * Existence of this file (and a build-time selector in `platform-services.ts`)
 * is what makes `npm run build:tommyato` type-check today; the throws are
 * defensive — actually exercising any method at runtime indicates a Phase 3
 * regression.
 */

import type {
  AchievementProgress,
  IMultiplayerTransport,
  IPlatformServices,
  LeaderboardEntry,
  LeaderboardSlug,
  RunScores,
} from "./platform-services";

const PHASE_3_ERROR = "TommyatoPlatform not yet implemented — Phase 3";

export class TommyatoPlatform implements IPlatformServices {
  readonly multiplayer: IMultiplayerTransport | null = null;

  init(): Promise<void> {
    throw new Error(PHASE_3_ERROR);
  }

  getUsername(): string {
    throw new Error(PHASE_3_ERROR);
  }

  signalLoadComplete(): Promise<void> {
    throw new Error(PHASE_3_ERROR);
  }

  signalFirstFrame(): void {
    throw new Error(PHASE_3_ERROR);
  }

  signalGameReady(): void {
    throw new Error(PHASE_3_ERROR);
  }

  loadSaveData(): Promise<string | null> {
    throw new Error(PHASE_3_ERROR);
  }

  writeSaveData(_data: string): Promise<void> {
    throw new Error(PHASE_3_ERROR);
  }

  submitScores(_input: RunScores, _username?: string): Promise<void> {
    throw new Error(PHASE_3_ERROR);
  }

  submitDailyScore(_score: number, _username?: string): Promise<void> {
    throw new Error(PHASE_3_ERROR);
  }

  fetchLeaderboardScores(_slug?: LeaderboardSlug): Promise<LeaderboardEntry[]> {
    throw new Error(PHASE_3_ERROR);
  }

  unlockAchievement(_id: string): boolean {
    throw new Error(PHASE_3_ERROR);
  }

  hasAchievement(_id: string): boolean {
    throw new Error(PHASE_3_ERROR);
  }

  listAchievementProgress(): AchievementProgress[] {
    throw new Error(PHASE_3_ERROR);
  }

  updateStat(_id: string, _value: number): void {
    throw new Error(PHASE_3_ERROR);
  }

  getStat(_id: string): number {
    throw new Error(PHASE_3_ERROR);
  }

  requestStats(): Promise<{ success: boolean }> {
    throw new Error(PHASE_3_ERROR);
  }

  storeStats(): void {
    throw new Error(PHASE_3_ERROR);
  }

  registerPauseHandlers(_onPause: () => void, _onResume: () => void): void {
    throw new Error(PHASE_3_ERROR);
  }

  isAudioEnabled(): boolean {
    throw new Error(PHASE_3_ERROR);
  }

  onAudioChange(_cb: (enabled: boolean) => void): void {
    throw new Error(PHASE_3_ERROR);
  }
}
