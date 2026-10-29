import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import { MAX_QUESTIONS, MAX_STATE_CHARS, capState } from "./limits.js";
import type { QuestionConfig, JevEvaluationResponse } from "./types.js";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";

// Cost bounds for the model-reachable RPC path. The jev_evaluate tool caps a
// single call at 24 questions so one model action cannot fire an unbounded
// number of paid judgments; the RPC agent must hold the same line, and the
// state payload is capped like jev-gate's 50 KB diff/file bound. Questions are
// rejected rather than truncated: silently cutting an instruction would change
// the judgment, while capping state marks the cut visibly.
const MAX_QUESTIONS_CHARS = MAX_STATE_CHARS;
/** RPC callers get a bounded evaluation; a lost reply must not hold a paid request open forever. */
const RPC_TIMEOUT_MS = 30_000;

export interface JevAgentTaskParams {
  task?: string;
  state?: string | Record<string, unknown>;
  type?: "choice" | "noul" | "score";
  instructions?: string;
  criteria?: any;
  questions?: Record<string, QuestionConfig>;
  model?: string;
}

export interface JevAgentResult {
  success: boolean;
  model: string;
  answers: Record<string, any>;
  primaryValue?: any;
  elapsedMs: number;
  usage?: any;
  error?: string;
}

export async function executeJevAgentTask(
  params: JevAgentTaskParams,
  client: JevClient,
  signal?: AbortSignal
): Promise<JevAgentResult> {
  if (!client.isConfigured()) {
    throw new Error("TypeSafe Jev unconfigured. Set TYPESAFE_API_KEY or PI_JEV_BASE_URL.");
  }

  let questions: Record<string, QuestionConfig> = {};
  const state = capState(params.state ?? params.task ?? "No state provided");

  if (params.questions && Object.keys(params.questions).length > 0) {
    const count = Object.keys(params.questions).length;
    if (count > MAX_QUESTIONS) {
      throw new Error(`Too many questions in one jev agent task (${count} > max ${MAX_QUESTIONS}). Split the evaluation.`);
    }
    if (JSON.stringify(params.questions).length > MAX_QUESTIONS_CHARS) {
      throw new Error(`Questions payload exceeds ${MAX_QUESTIONS_CHARS} characters. Move bulk material into state and keep questions short.`);
    }
    questions = params.questions;
  } else if (params.type === "choice") {
    questions["judgment"] = {
      type: "choice",
      instructions: params.instructions || params.task || "Categorize state",
      criteria: params.criteria || { yes: null, no: null },
    };
  } else if (params.type === "score") {
    questions["judgment"] = {
      type: "score",
      instructions: params.instructions || params.task || "Score state",
      criteria: Array.isArray(params.criteria) ? params.criteria : ["poor", "acceptable", "good"],
    };
  } else {
    // Default to noul (probability / binary check)
    questions["judgment"] = {
      type: "noul",
      instructions: params.instructions || params.task || "Evaluate state",
      criteria: typeof params.criteria === "string" ? params.criteria : undefined,
    };
  }

  const response: JevEvaluationResponse = await client.evaluate(
    {
      state,
      questions,
      model: params.model,
    },
    signal
  );

  const primaryAnswer = response.answers["judgment"] ?? Object.values(response.answers)[0];

  return {
    success: true,
    model: response.model,
    answers: response.answers,
    primaryValue: primaryAnswer?.value,
    elapsedMs: response.elapsedMs,
    usage: response.usage,
  };
}

export class JevAgentHandler {
  constructor(private pi: ExtensionAPI, private jevClient: JevClient) {}

  public install(): void {
    // Listen for subagent RPC calls directed at agent 'jev' or 'typesafe-jev'
    this.pi.events.on(RPC_REQUEST, async (req: any) => {
      if (!req || req.version !== 1) return;
      const targetAgent = req.params?.agent || req.params?.agentType;
      if (targetAgent !== "jev" && targetAgent !== "typesafe-jev") return;

      const requestId = req.requestId;
      const replyEvent = `${RPC_REPLY}${requestId}`;

      try {
        const taskParams: JevAgentTaskParams = {
          task: req.params?.task,
          state: req.params?.state ?? req.params?.args?.state,
          type: req.params?.type ?? req.params?.args?.type,
          instructions: req.params?.instructions ?? req.params?.args?.instructions,
          criteria: req.params?.criteria ?? req.params?.args?.criteria,
          questions: req.params?.questions ?? req.params?.args?.questions,
          model: req.params?.model ?? req.params?.args?.model,
        };

        // Bounded signal: without it a model-initiated RPC evaluation could
        // run (and bill) indefinitely with no cancellation path.
        const result = await executeJevAgentTask(taskParams, this.jevClient, AbortSignal.timeout(RPC_TIMEOUT_MS));
        this.pi.events.emit(replyEvent, {
          success: true,
          data: {
            id: `jev-${Date.now()}`,
            output: JSON.stringify(result, null, 2),
            result,
          },
        });
      } catch (err: any) {
        this.pi.events.emit(replyEvent, {
          success: false,
          error: { message: err?.message || String(err) },
        });
      }
    });
  }
}
