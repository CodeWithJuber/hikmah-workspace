import { ownerIdentity, sameOrigin, failure, KernelHttpError } from '@/lib/kernel/server';
import { getStorage } from '@/server/storage.mjs';
import {
  createReleaseStore,
  startCanaryStage,
  nextCanaryStage,
  checkCanaryGate,
  recordCanaryOutcome,
  CANARY_STAGES,
  LearningReleaseError,
} from '@/lib/learning/releases';
import { metricsReport, type LanguageMetrics } from '@/lib/learning/metrics';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const store = () => createReleaseStore(getStorage().raw);

async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new LearningReleaseError('bad-body', 'Send a JSON request body.', 400);
  const text = await request.text();
  if (text.length > 512_000)
    throw new LearningReleaseError('too-large', 'Use a smaller canary report.', 413);
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new LearningReleaseError('bad-body', 'Send a canary action.', 400);
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LearningReleaseError) throw error;
    throw new LearningReleaseError('bad-body', 'Send a valid JSON request body.', 400);
  }
}

const stageCohort = (stage: string) => CANARY_STAGES.find((s) => s.stage === stage)?.cohortPct ?? 0;

function stageState(release: { canaries: { stage: string; status: string }[] }) {
  return {
    passed: release.canaries.filter((c) => c.status === 'passed').map((c) => c.stage),
    blocked: release.canaries.filter((c) => c.status === 'blocked').map((c) => c.stage),
  };
}

/** Start a canary stage, or record a stage's metric report. Stages run
 * 5% → 25% → 100% in order; a failed gate blocks advancement until the
 * owner retries the stage or rolls back (inspect-then-decide). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    await ownerIdentity();
    sameOrigin(request);
    const body = await readBody(request);
    const releases = store();
    if (body.action === 'start') {
      if (typeof body.stage !== 'string') return fail('Choose a canary stage to start.', 400);
      const release = releases.release(params.id);
      if (release.status !== 'approved' && release.status !== 'canarying')
        return fail(
          `Release ${params.id} is ${release.status}; only an approved release can canary.`,
          409,
        );
      const { passed, blocked } = stageState(release);
      const stage = startCanaryStage({ stage: body.stage, passed, blocked });
      const canaryId = releases.startCanary({
        releaseId: params.id,
        stage,
        cohortPct: stageCohort(stage),
      });
      if (release.status === 'approved') releases.setStatus(params.id, 'canarying', ['approved']);
      return Response.json(
        { canaryId, stage, cohortPct: stageCohort(stage), retry: blocked.includes(stage) },
        { headers },
      );
    }
    if (body.action === 'record') {
      if (typeof body.canaryId !== 'string' || !body.canaryId)
        return fail('Choose the canary stage to record.', 400);
      const rows = Array.isArray(body.metrics) ? body.metrics : [];
      const metrics: LanguageMetrics[] = rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          language: String(r.language ?? ''),
          accuracy: Number(r.accuracy),
          secondary:
            r.secondary && typeof r.secondary === 'object'
              ? (r.secondary as Record<string, number>)
              : {},
          sampleCount: Number(r.sampleCount ?? 0),
        };
      });
      // Unlabeled weights are refused here, at the surface that shows them.
      const report = metricsReport({
        metrics,
        weights: body.weights ?? null,
        provenance: typeof body.provenance === 'string' ? body.provenance : null,
      });
      // The gate compares against what production runs today: the newest
      // live release other than this one. A first release has no baseline.
      const live = releases.latestLive(params.id);
      const baseline = live ? releases.lastPassedMetrics(live.id) : null;
      const gate = checkCanaryGate({ baseline, candidate: report.perLanguage });
      const outcome = recordCanaryOutcome({ gatePassed: gate.passed });
      releases.completeCanary({
        canaryId: body.canaryId,
        outcome,
        metricsJson: JSON.stringify(report),
      });
      return Response.json({ outcome, gate, report }, { headers });
    }
    return fail('Choose a valid canary action.', 400);
  } catch (error) {
    if (error instanceof LearningReleaseError) return fail(error.message, error.status);
    if (error instanceof KernelHttpError) return failure(error);
    return fail('The canary update could not be recorded. Try again.', 503);
  }
}

/** The canary plan for a release: which stage is next, which are blocked. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    await ownerIdentity();
    const releases = store();
    const release = releases.release(params.id);
    const { passed, blocked } = stageState(release);
    return Response.json(
      { stages: CANARY_STAGES, passed, blocked, next: nextCanaryStage({ passed, blocked }) },
      { headers },
    );
  } catch (error) {
    if (error instanceof LearningReleaseError) return fail(error.message, error.status);
    return failure(error);
  }
}
