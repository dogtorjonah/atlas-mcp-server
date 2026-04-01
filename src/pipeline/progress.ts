interface PhaseProgressState {
  key: string;
  label: string;
  total: number;
  completed: number;
  startedAt: number | null;
  failedFiles: string[];
  done: boolean;
}

export interface PhaseProgressReporter {
  begin(phaseKey: string, filePath?: string): void;
  complete(phaseKey: string, filePath?: string): void;
  fail(phaseKey: string, filePath: string, message: string): void;
  finish(summary: string): void;
}

export interface PhaseProgressSpec {
  key: string;
  label: string;
  total: number;
}

const BAR_WIDTH = 18;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}m ${remainder}s`;
}

function buildBar(completed: number, total: number): string {
  if (total <= 0) {
    return '█'.repeat(BAR_WIDTH);
  }

  const normalized = Math.min(Math.max(completed / total, 0), 1);
  const filled = Math.min(BAR_WIDTH, Math.round(normalized * BAR_WIDTH));
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(BAR_WIDTH - filled, 0))}`;
}

function formatFailedFiles(files: string[]): string {
  if (files.length === 0) {
    return '';
  }
  const preview = files.slice(0, 2).join(', ');
  return files.length > 2 ? `${preview}, ...` : preview;
}

function formatPhaseLine(state: PhaseProgressState, labelWidth: number): string {
  const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
  const completed = Math.min(state.completed, state.total);
  const started = state.startedAt !== null;
  const finished = state.done || completed >= state.total;
  const failedCount = state.failedFiles.length;
  const bar = buildBar(completed, state.total);
  const count = `${completed}/${state.total}`;
  const label = state.label.padEnd(labelWidth);

  let suffix: string;
  if (!started && completed === 0) {
    suffix = 'waiting...';
  } else if (finished) {
    suffix = failedCount > 0
      ? `✗ ${failedCount} failed (${formatFailedFiles(state.failedFiles)})`
      : `✓ ${formatDuration(elapsed)}`;
  } else if (completed > 0) {
    const rateMs = elapsed / completed;
    const remaining = Math.max(state.total - completed, 0);
    const eta = formatDuration(rateMs * remaining);
    suffix = failedCount > 0
      ? `${eta} • ${failedCount} failed`
      : `~${eta} left`;
  } else {
    suffix = 'starting...';
  }

  return `[${state.key}] ${label} ${bar} ${count}  ${suffix}`;
}

export function createPhaseProgressReporter(specs: PhaseProgressSpec[]): PhaseProgressReporter {
  const states = specs.map((spec) => ({
    key: spec.key,
    label: spec.label,
    total: spec.total,
    completed: 0,
    startedAt: null,
    failedFiles: [] as string[],
    done: false,
  }));
  const interactive = process.stdout.isTTY;
  const labelWidth = Math.max(...states.map((state) => state.label.length), 0);
  let renderedLines = 0;
  let renderedOnce = false;

  const render = (): void => {
    if (!interactive) {
      return;
    }

    const lines = states.map((state) => formatPhaseLine(state, labelWidth));
    if (renderedOnce) {
      process.stdout.write(`\u001b[${renderedLines}F`);
    }
    for (let i = 0; i < lines.length; i += 1) {
      process.stdout.write(`\u001b[2K${lines[i]}`);
      if (i < lines.length - 1) {
        process.stdout.write('\n');
      }
    }
    renderedLines = lines.length;
    renderedOnce = true;
  };

  const getState = (phaseKey: string): PhaseProgressState => {
    const state = states.find((entry) => entry.key === phaseKey);
    if (!state) {
      throw new Error(`Unknown progress phase: ${phaseKey}`);
    }
    return state;
  };

  const touch = (phaseKey: string): PhaseProgressState => {
    const state = getState(phaseKey);
    if (state.startedAt === null) {
      state.startedAt = Date.now();
    }
    return state;
  };

  return {
    begin(phaseKey: string, _filePath?: string): void {
      touch(phaseKey);
      render();
    },
    complete(phaseKey: string): void {
      const state = touch(phaseKey);
      state.completed += 1;
      if (state.completed > state.total) {
        state.completed = state.total;
      }
      render();
    },
    fail(phaseKey: string, filePath: string, message: string): void {
      const state = touch(phaseKey);
      state.completed += 1;
      if (state.completed > state.total) {
        state.completed = state.total;
      }
      state.failedFiles.push(filePath);
      state.done = false;
      render();
    },
    finish(summary: string): void {
      render();
      if (interactive && renderedOnce) {
        process.stdout.write('\n');
      }
      console.log(`[atlas-init] ${summary}`);
    },
  };
}
