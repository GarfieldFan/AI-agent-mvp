import { apiFetch } from "@/lib/api";

export type IntegrationStatus = {
  available: boolean;
  detail: string | null;
};

export type IntegrationsResponse = {
  comfyui: IntegrationStatus;
};

/** Admin/owner only — see backend/apis/agent.py's `get_integrations`. A
 * lightweight reachability check for third-party services a stub agent
 * capability would actually need (currently just ComfyUI, for poster
 * generation) — lets the dashboard gray out a capability card up front
 * instead of only discovering it's unreachable after clicking "Try it". */
export function getIntegrations() {
  return apiFetch<IntegrationsResponse>("/api/agent/integrations");
}
