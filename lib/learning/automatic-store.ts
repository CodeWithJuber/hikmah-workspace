import { randomUUID } from 'node:crypto';
import { sealRunConfig } from '../../server/run-credentials.mjs';
import type { SqliteHandle } from '../runs/store.ts';
import type { Sentence } from '../context-model/field-model.ts';
import {
  AUTOMATIC_DAILY_REQUESTS,
  AUTOMATIC_MAX_CORPUS,
  AUTOMATIC_SENTENCES_PER_REQUEST,
  type AutomaticSnapshot,
  type AutomaticStatus,
} from './automatic-types.ts';

export type AutomaticSentence = { text: string; forms: string[]; fingerprint: string };
export type AutomaticJob = {
  id: string;
  user_id: string;
  example_id: string;
  consent_revision: number;
  language: string;
  sentences: string;
  config: string;
  status: string;
  reason: string;
  requested_at: string | null;
  annotations: string | null;
  checkpoint_id: string | null;
  receipt: string | null;
  created_at: string;
  updated_at: string;
};
export type AutomaticReceipt = {
  approved: boolean;
  gain: number;
  scope: string;
  reason: string;
  basedOn: string;
  restoreVersion: string;
  automatic: true;
  [key: string]: unknown;
};

const ACTIVE = "('preparing','training','evaluating')";
const UNFINISHED = "('queued','preparing','training','evaluating')";
const SCRUB_CONFIG = "json_remove(config,'$.apiKey','$.providerCredential')";
const LEASE_MS = 30_000;
const MAX_QUEUE = 6;

/** Durable jobs and a fenced global lease. No provider or framework imports. */
export function createAutomaticStore(db: SqliteHandle, now = () => new Date().toISOString()) {
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const live = (job: AutomaticJob, holder?: string) => {
    const current = db
      .prepare(
        `SELECT j.id FROM automatic_learning_jobs j
         JOIN learning_policies p ON p.user_id=j.user_id
         JOIN learning_examples e ON e.id=j.example_id AND e.user_id=j.user_id
         WHERE j.id=? AND j.user_id=? AND j.status IN ${UNFINISHED}
           AND p.enabled=1 AND p.automatic=1 AND p.revision=j.consent_revision
           AND j.consent_revision=?`,
      )
      .get(job.id, job.user_id, job.consent_revision);
    return Boolean(
      current &&
      (!holder ||
        db
          .prepare('SELECT id FROM automatic_learning_lock WHERE holder=? AND expires_at>?')
          .get(holder, now())),
    );
  };
  const finish = (job: AutomaticJob, status: string, reason: string, receipt?: unknown) =>
    db
      .prepare(
        `UPDATE automatic_learning_jobs SET status=?,reason=?,receipt=?,config=${SCRUB_CONFIG},updated_at=?
         WHERE id=? AND user_id=? AND status IN ${UNFINISHED}`,
      )
      .run(status, reason, receipt ? JSON.stringify(receipt) : null, now(), job.id, job.user_id);
  const cancel = (userId: string) => {
    db.prepare(
      `UPDATE automatic_learning_jobs SET status='held',reason='Learning settings changed. New chats use your current choice.',
       config=${SCRUB_CONFIG},updated_at=? WHERE user_id=? AND status IN ${UNFINISHED}`,
    ).run(now(), userId);
  };
  return {
    live,
    cancel,
    enqueue(input: {
      userId: string;
      exampleId: string;
      revision: number;
      language: string;
      sentences: AutomaticSentence[];
      config: Record<string, unknown>;
    }): boolean {
      if (!input.sentences.length || input.sentences.length > AUTOMATIC_SENTENCES_PER_REQUEST)
        return false;
      const id = 'auto_' + randomUUID();
      const config = JSON.stringify(sealRunConfig(input.config, { id, user_id: input.userId }));
      const result = db
        .prepare(
          `INSERT INTO automatic_learning_jobs
           (id,user_id,example_id,consent_revision,language,sentences,config,created_at,updated_at)
           SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (
             SELECT 1 FROM learning_examples e JOIN learning_policies p ON p.user_id=e.user_id
             WHERE e.id=? AND e.user_id=? AND p.enabled=1 AND p.automatic=1 AND p.revision=?
           ) AND (SELECT COUNT(*) FROM automatic_learning_jobs WHERE user_id=? AND status IN ${UNFINISHED})<?
           ON CONFLICT(user_id,example_id) DO NOTHING`,
        )
        .run(
          id,
          input.userId,
          input.exampleId,
          input.revision,
          input.language,
          JSON.stringify(input.sentences),
          config,
          now(),
          now(),
          input.exampleId,
          input.userId,
          input.revision,
          input.userId,
          MAX_QUEUE,
        ) as { changes: number };
      return Number(result.changes) === 1;
    },
    /** Source deletion cascades jobs/annotations. This also enforces retention
     * when nobody has opened the learning screen. */
    purge() {
      const policies = db.prepare('SELECT user_id,retention_days FROM learning_policies').all() as {
        user_id: string;
        retention_days: number;
      }[];
      for (const row of policies) {
        const cutoff = new Date(Date.parse(now()) - row.retention_days * 86_400_000).toISOString();
        db.prepare('DELETE FROM learning_examples WHERE user_id=? AND created_at<?').run(
          row.user_id,
          cutoff,
        );
      }
      const yesterday = new Date(Date.parse(now()) - 86_400_000).toISOString();
      db.prepare(
        `UPDATE automatic_learning_jobs SET status='held',reason='This queued sample expired. Learning continues with new chats.',
         config=${SCRUB_CONFIG},updated_at=? WHERE status='queued' AND created_at<?`,
      ).run(now(), yesterday);
      db.prepare(
        `UPDATE automatic_learning_jobs SET status='held',reason='Learning consent changed.',
         config=${SCRUB_CONFIG},updated_at=? WHERE status IN ${UNFINISHED} AND NOT EXISTS (
           SELECT 1 FROM learning_policies p WHERE p.user_id=automatic_learning_jobs.user_id
           AND p.enabled=1 AND p.automatic=1 AND p.revision=automatic_learning_jobs.consent_revision
         )`,
      ).run(now());
      db.prepare('DELETE FROM automatic_learning_budget WHERE day<?').run(yesterday.slice(0, 10));
    },
    /** At most one automatic job across processes. Expired annotation requests
     * are never retried: a lost response could still have been billed. Local
     * fitting can safely resume from persisted teacher annotations. */
    claim(holder: string): AutomaticJob | null {
      return transaction(() => {
        const expires = new Date(Date.parse(now()) + LEASE_MS).toISOString();
        const lock = db
          .prepare(
            `INSERT INTO automatic_learning_lock(id,holder,expires_at) VALUES(1,?,?)
           ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
           WHERE automatic_learning_lock.expires_at<=? RETURNING id`,
          )
          .get(holder, expires, now());
        if (!lock) return null;
        db.prepare(
          `UPDATE automatic_learning_jobs SET status='error',reason='The server restarted during annotation. It will learn from a future chat without repeating this provider request.',
           config=${SCRUB_CONFIG},updated_at=? WHERE status IN ${ACTIVE} AND requested_at IS NOT NULL AND annotations IS NULL`,
        ).run(now());
        db.prepare(
          `UPDATE automatic_learning_jobs SET status='queued',updated_at=? WHERE status IN ${ACTIVE}`,
        ).run(now());
        const job = db
          .prepare(
            `UPDATE automatic_learning_jobs SET status=CASE WHEN annotations IS NULL THEN 'preparing' ELSE 'training' END,updated_at=?
           WHERE id=(SELECT j.id FROM automatic_learning_jobs j JOIN learning_policies p ON p.user_id=j.user_id
           WHERE j.status='queued' AND p.enabled=1 AND p.automatic=1 AND p.revision=j.consent_revision
           ORDER BY j.created_at,j.id LIMIT 1) RETURNING *`,
          )
          .get(now()) as AutomaticJob | undefined;
        if (!job) db.prepare('DELETE FROM automatic_learning_lock WHERE holder=?').run(holder);
        return job ?? null;
      });
    },
    heartbeat(holder: string): boolean {
      const row = db
        .prepare(
          'UPDATE automatic_learning_lock SET expires_at=? WHERE holder=? AND expires_at>? RETURNING id',
        )
        .get(new Date(Date.parse(now()) + LEASE_MS).toISOString(), holder, now());
      return Boolean(row);
    },
    release(holder: string) {
      db.prepare('DELETE FROM automatic_learning_lock WHERE holder=?').run(holder);
    },
    reserveRequest(job: AutomaticJob, holder: string): boolean {
      return transaction(() => {
        if (!live(job, holder)) return false;
        const existing = db
          .prepare('SELECT requested_at FROM automatic_learning_jobs WHERE id=?')
          .get(job.id) as { requested_at: string | null };
        if (existing.requested_at) return false;
        const row = db
          .prepare(
            `INSERT INTO automatic_learning_budget(user_id,day,requests) VALUES(?,?,1)
           ON CONFLICT(user_id,day) DO UPDATE SET requests=requests+1 WHERE requests<? RETURNING requests`,
          )
          .get(job.user_id, now().slice(0, 10), AUTOMATIC_DAILY_REQUESTS);
        if (!row) {
          finish(job, 'held', 'Today’s learning limit is reached. New chats can be used tomorrow.');
          return false;
        }
        db.prepare('UPDATE automatic_learning_jobs SET requested_at=?,updated_at=? WHERE id=?').run(
          now(),
          now(),
          job.id,
        );
        return true;
      });
    },
    saveAnnotations(job: AutomaticJob, holder: string, rows: Sentence[]): boolean {
      return transaction(() => {
        if (!live(job, holder)) return false;
        const originals = JSON.parse(job.sentences) as AutomaticSentence[];
        for (const row of rows) {
          const source = originals.find((s) => s.text === row.text);
          if (!source) throw Error('Annotation source changed.');
          db.prepare(
            `INSERT OR IGNORE INTO automatic_learning_annotations
             (user_id,language,fingerprint,example_id,annotation,created_at) VALUES(?,?,?,?,?,?)`,
          ).run(
            job.user_id,
            job.language,
            source.fingerprint,
            job.example_id,
            JSON.stringify(row),
            now(),
          );
        }
        db.prepare(
          `DELETE FROM automatic_learning_annotations WHERE user_id=? AND language=? AND fingerprint NOT IN (
           SELECT fingerprint FROM automatic_learning_annotations WHERE user_id=? AND language=?
           ORDER BY created_at DESC,fingerprint LIMIT ?)`,
        ).run(job.user_id, job.language, job.user_id, job.language, AUTOMATIC_MAX_CORPUS);
        db.prepare(
          `UPDATE automatic_learning_jobs SET annotations=?,status='training',config=${SCRUB_CONFIG},updated_at=? WHERE id=?`,
        ).run(JSON.stringify(rows), now(), job.id);
        return true;
      });
    },
    annotations(userId: string, language: string): Sentence[] {
      return (
        db
          .prepare(
            'SELECT annotation FROM automatic_learning_annotations WHERE user_id=? AND language=? ORDER BY created_at,fingerprint LIMIT ?',
          )
          .all(userId, language, AUTOMATIC_MAX_CORPUS) as { annotation: string }[]
      ).map((r) => JSON.parse(r.annotation));
    },
    stage(job: AutomaticJob, holder: string, status: 'training' | 'evaluating') {
      if (live(job, holder))
        db.prepare('UPDATE automatic_learning_jobs SET status=?,updated_at=? WHERE id=?').run(
          status,
          now(),
          job.id,
        );
    },
    finish(
      job: AutomaticJob,
      holder: string,
      status: 'held' | 'error',
      reason: string,
      receipt?: unknown,
    ) {
      if (live(job, holder)) finish(job, status, reason, receipt);
    },
    active(userId: string, language: string) {
      return db
        .prepare(
          `SELECT v.id,v.blob_key,v.receipt FROM context_active a JOIN context_versions v ON v.id=a.version_id
         WHERE a.user_id=? AND a.language=? AND v.user_id=?`,
        )
        .get(userId, language, userId) as
        { id: string; blob_key: string; receipt: string } | undefined;
    },
    /** Register the object before writing it. A live lease protects a pending
     * publication; a crashed writer leaves a durable cleanup obligation. */
    stageCheckpoint(job: AutomaticJob, holder: string, key: string): boolean {
      return transaction(() => {
        if (!live(job, holder)) return false;
        db.prepare('INSERT INTO automatic_learning_garbage(blob_key,holder) VALUES(?,?)').run(
          key,
          holder,
        );
        return true;
      });
    },
    abandonCheckpoint(key: string) {
      db.prepare(
        'INSERT INTO automatic_learning_garbage(blob_key,holder) VALUES(?,NULL) ON CONFLICT(blob_key) DO UPDATE SET holder=NULL',
      ).run(key);
    },
    /** Gate result, user consent and parent checkpoint are checked together.
     * A competing manual activation wins rather than being overwritten. */
    publish(
      job: AutomaticJob,
      holder: string,
      checkpoint: { id: string; key: string; receipt: AutomaticReceipt },
    ): boolean {
      return transaction(() => {
        if (!live(job, holder)) return false;
        const active = this.active(job.user_id, job.language);
        if ((active?.id ?? 'released') !== checkpoint.receipt.basedOn) {
          finish(job, 'held', 'Your co-model changed while training. This candidate was held.');
          return false;
        }
        db.prepare(
          'INSERT INTO context_versions(id,user_id,language,blob_key,receipt,created_at) VALUES(?,?,?,?,?,?)',
        ).run(
          checkpoint.id,
          job.user_id,
          job.language,
          checkpoint.key,
          JSON.stringify(checkpoint.receipt),
          now(),
        );
        if (checkpoint.receipt.approved)
          db.prepare(
            `INSERT INTO context_active(id,user_id,language,version_id,revision) VALUES(?,?,?,?,0)
           ON CONFLICT(id) DO UPDATE SET version_id=excluded.version_id,revision=context_active.revision+1`,
          ).run(job.user_id + ':' + job.language, job.user_id, job.language, checkpoint.id);
        finish(
          job,
          checkpoint.receipt.approved ? 'updated' : 'held',
          checkpoint.receipt.reason,
          checkpoint.receipt,
        );
        db.prepare('UPDATE automatic_learning_jobs SET checkpoint_id=? WHERE id=?').run(
          checkpoint.id,
          job.id,
        );
        db.prepare('DELETE FROM automatic_learning_garbage WHERE blob_key=?').run(checkpoint.key);
        return true;
      });
    },
    /** Used inside the enclosing clear transaction. Returns blobs to remove. */
    clear(userId: string): string[] {
      cancel(userId);
      const automatic = db
        .prepare(
          "SELECT id,blob_key,receipt FROM context_versions WHERE user_id=? AND json_extract(receipt,'$.automatic')=1",
        )
        .all(userId) as { id: string; blob_key: string; receipt: string }[];
      for (const version of automatic) {
        db.prepare('INSERT OR IGNORE INTO automatic_learning_garbage(blob_key) VALUES(?)').run(
          version.blob_key,
        );
        const receipt = JSON.parse(version.receipt) as AutomaticReceipt;
        const previous =
          receipt.restoreVersion && receipt.restoreVersion !== 'released'
            ? (db
                .prepare('SELECT id FROM context_versions WHERE id=? AND user_id=?')
                .get(receipt.restoreVersion, userId) as { id: string } | undefined)
            : undefined;
        if (previous)
          db.prepare(
            'UPDATE context_active SET version_id=?,revision=revision+1 WHERE user_id=? AND version_id=?',
          ).run(previous.id, userId, version.id);
        else
          db.prepare('DELETE FROM context_active WHERE user_id=? AND version_id=?').run(
            userId,
            version.id,
          );
      }
      db.prepare(
        "DELETE FROM context_versions WHERE user_id=? AND json_extract(receipt,'$.automatic')=1",
      ).run(userId);
      db.prepare('DELETE FROM automatic_learning_jobs WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM automatic_learning_annotations WHERE user_id=?').run(userId);
      return automatic.map((v) => v.blob_key);
    },
    pruneCheckpoints(userId: string, language: string) {
      transaction(() => {
        const old = db
          .prepare(
            `SELECT v.id,v.blob_key FROM context_versions v WHERE v.user_id=? AND v.language=?
           AND json_extract(v.receipt,'$.automatic')=1
           AND NOT EXISTS(SELECT 1 FROM context_active a WHERE a.version_id=v.id)
           ORDER BY v.created_at DESC,v.id DESC LIMIT -1 OFFSET 5`,
          )
          .all(userId, language) as { id: string; blob_key: string }[];
        for (const row of old) {
          db.prepare('INSERT OR IGNORE INTO automatic_learning_garbage(blob_key) VALUES(?)').run(
            row.blob_key,
          );
          db.prepare('DELETE FROM context_versions WHERE id=? AND user_id=?').run(row.id, userId);
        }
      });
    },
    garbage(): string[] {
      return (
        db
          .prepare(
            `SELECT g.blob_key FROM automatic_learning_garbage g WHERE holder IS NULL OR NOT EXISTS(
        SELECT 1 FROM automatic_learning_lock l WHERE l.holder=g.holder AND l.expires_at>?
      ) LIMIT 20`,
          )
          .all(now()) as { blob_key: string }[]
      ).map((row) => row.blob_key);
    },
    cleaned(key: string) {
      db.prepare('DELETE FROM automatic_learning_garbage WHERE blob_key=?').run(key);
    },
    snapshot(userId: string): AutomaticSnapshot {
      const policy = db
        .prepare('SELECT enabled,automatic FROM learning_policies WHERE user_id=?')
        .get(userId) as { enabled: number; automatic: number } | undefined;
      const latest = db
        .prepare(
          'SELECT * FROM automatic_learning_jobs WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
        )
        .get(userId) as AutomaticJob | undefined;
      const active = db
        .prepare(
          `SELECT * FROM automatic_learning_jobs WHERE user_id=? AND status IN ${ACTIVE} LIMIT 1`,
        )
        .get(userId) as AutomaticJob | undefined;
      const row = active ?? latest;
      const queued = db
        .prepare(
          "SELECT COUNT(*) AS n FROM automatic_learning_jobs WHERE user_id=? AND status='queued'",
        )
        .get(userId) as { n: number };
      const budget = db
        .prepare('SELECT requests FROM automatic_learning_budget WHERE user_id=? AND day=?')
        .get(userId, now().slice(0, 10)) as { requests: number } | undefined;
      const running = policy?.enabled === 1 && policy.automatic === 1;
      const receipt = row?.receipt ? (JSON.parse(row.receipt) as AutomaticReceipt) : null;
      return {
        status: !running
          ? 'paused'
          : !row || row.status === 'queued'
            ? 'waiting'
            : (row.status as AutomaticStatus),
        reason: !running
          ? 'Automatic learning is off.'
          : row?.reason || 'Ready to learn from new successful chats.',
        queued: Number(queued.n),
        requestsToday: Number(budget?.requests ?? 0),
        dailyLimit: AUTOMATIC_DAILY_REQUESTS,
        sentencesPerRequest: AUTOMATIC_SENTENCES_PER_REQUEST,
        lastAt: row?.updated_at ?? null,
        language: row?.language ?? null,
        checkpointId: row?.checkpoint_id ?? null,
        metric: receipt
          ? { scope: receipt.scope, gain: receipt.gain, approved: receipt.approved }
          : null,
      };
    },
  };
}
export type AutomaticStore = ReturnType<typeof createAutomaticStore>;
