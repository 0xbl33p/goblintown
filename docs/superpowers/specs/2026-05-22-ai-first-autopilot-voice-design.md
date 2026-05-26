# AI-First Autopilot Voice Harness Design

## Goal

Add a voice control plane to the Tank UI so a user can talk to the autopilot, hear spoken responses, and let the model safely launch existing Goblintown workflows through allowlisted tools.

## Tracking Issues

- #14 Add Realtime voice session layer for AI-first autopilot.
- #15 Add Tank microphone controls and voice activity UI.
- #16 Expose safe autopilot tools for voice-driven workflows.
- #18 Define autopilot policy and control boundaries for the voice harness.

## Current State

Goblintown is currently text-first. The Tank UI submits text payloads to `/api/rite`, `/api/plan`, `/api/thesis`, and `/api/cli`, then streams run events back over server-sent events. The model layer uses text Chat Completions calls. There is no microphone capture, audio playback, WebRTC session, speech transcription, or voice-specific tool surface.

## Recommended Architecture

Use OpenAI Realtime over WebRTC for browser voice sessions. The browser owns microphone capture and audio playback. The server owns credential handling, Realtime session setup, and safe local tool execution.

The voice agent should sit above the existing orchestration pipeline. It should not replace rites, plans, thesis generation, or run streaming. Instead, it should call small, typed autopilot tools that map onto the existing APIs.

## Voice Tool Surface

Expose only allowlisted tools to the Realtime model:

- `get_harness_status`: returns warren name, active run state, loot count, rite count, and whether model credentials are configured.
- `list_recent_runs`: returns recent run ids, task summaries, status, and final rite ids.
- `start_rite`: starts a rite with a task, pack size, memory flag, debate flag, troll tools flag, and optional scan globs.
- `start_plan`: starts a plan with a task, node cap, replan cap, memory flag, and output format.
- `start_thesis`: starts a thesis request with subject, horizon, context, memory flag, and optional scan globs.
- `summarize_run`: returns the stored summary and final artifact pointer for a run.

Do not expose the raw `/api/cli` endpoint as a voice tool in the first version. Arbitrary command execution is too broad for an autopilot voice surface.

## Server API

Add these server endpoints:

- `GET /api/voice/status`: reports voice availability, configured provider, supported model, and missing credential state.
- `POST /api/voice/session`: creates a Realtime browser session without exposing long-lived provider credentials to the client.
- `POST /api/voice/tool`: executes one allowlisted voice tool call and returns a JSON result suitable for `function_call_output`.

The server should reuse existing provider secret resolution where possible, but the first implementation should support OpenAI Realtime only. Other OpenAI-compatible providers can stay on the existing text route until they support equivalent browser voice sessions.

## Browser UI

Add a compact voice control strip to Tank:

- Connect/disconnect microphone button.
- Mute/unmute button.
- Voice status text: unavailable, ready, connecting, listening, speaking, tool running, or error.
- A small transcript/activity pane showing user utterances, assistant summaries, and tool calls.
- A hidden audio element attached to the Realtime remote stream.

The controls should degrade gracefully. If the browser denies microphone permission, the UI should show a clear error and keep text workflows usable.

## Data Flow

1. User clicks the voice connect button.
2. Browser requests microphone access.
3. Browser asks the server for a Realtime session.
4. Server creates the session using locally stored credentials.
5. Browser establishes a WebRTC peer connection with OpenAI Realtime.
6. Realtime model hears the user and speaks back.
7. When the model requests a tool call, browser forwards the call to `/api/voice/tool`.
8. Server validates the tool name and arguments, executes the mapped Goblintown operation, and returns JSON.
9. Browser sends the tool result back to Realtime and requests the model to continue.
10. Existing SSE run streams continue to drive Tank animations and run status.

## Safety Rules

- Keep long-lived API keys server-side.
- Reject unknown tool names.
- Validate every tool argument before execution.
- Keep arbitrary CLI execution out of voice.
- Add a short confirmation behavior for high-impact actions, such as starting multiple long-running workflows.
- Keep voice unavailable rather than silently falling back to unsafe behavior when credentials or microphone access are missing.

## Autopilot Policy Boundaries

Voice-driven autopilot needs explicit autonomy levels before tools can perform work:

- Read-only actions may run without confirmation: harness status, recent runs, and run summaries.
- Single workflow starts should require clear user intent in the current voice turn.
- Multi-workflow starts, destructive resets, provider changes, branch cleanup, or command execution should require explicit confirmation or remain forbidden.
- A global stop/interrupt action should silence voice playback immediately and expose a route for cancelling or detaching from active runs.
- Each voice tool call should leave an audit record with tool name, normalized arguments, result, and run id when applicable. The audit record should not store long-lived secrets or raw microphone audio.

## Testing Plan

- Unit test voice status payloads for configured and missing credential states.
- Unit test voice tool allowlist validation and argument normalization.
- Unit test that unsafe tool names are rejected.
- Unit test autopilot policy classification for read-only, confirm-required, and forbidden actions.
- Unit test Realtime session payload construction without real network calls.
- UI source test for voice controls, transcript area, and voice status states.
- Run the full existing `npm test` suite after the changes.

## Implementation Slices

1. Add `src/voice.ts` for voice status, tool schema definitions, session payload creation, and tool argument validation.
2. Add `src/voice-policy.ts` for autonomy levels, confirmation requirements, forbidden actions, and audit event shape.
3. Add voice server routes in `src/server.ts`.
4. Add Tank UI controls and browser Realtime client logic in the existing Tank script.
5. Add focused tests for `src/voice.ts`, `src/voice-policy.ts`, and the Tank voice UI surface.
6. Update README usage and security notes.

## Risks

- The Codex in-app browser may need explicit microphone permission support even though localhost is a secure context.
- Realtime voice is OpenAI-specific in the first version and should not pretend to be provider-portable.
- WebRTC failures can be opaque. The UI should report signaling, microphone, and session errors separately.
- The existing `src/server.ts` file is large. New reusable voice logic should live in `src/voice.ts`; `server.ts` should only wire routes and UI.
