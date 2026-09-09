import { getModelSettings, listModels } from "@/lib/models";

export type SetupStatus = {
  /** True once the currently-selected chat_provider/chat_model combo is
   * actually usable (matches a `selectable: true` entry in `GET
   * /agent/models`'s `chat_models`) — the same signal `ModelSettingsPanel`
   * itself uses to show/hide a "Not configured" badge, reused here to
   * decide whether the setup wizard still has something to do. */
  chatConfigured: boolean;
};

/** Best-effort — a caller should treat a thrown error the same as "can't
 * tell," not as "setup is needed" (e.g. `SetupStatusBanner` swallows
 * failures rather than nagging every visitor whenever the backend has a
 * transient blip). */
export async function checkSetupStatus(): Promise<SetupStatus> {
  const [models, settings] = await Promise.all([listModels(), getModelSettings()]);
  const chatConfigured = models.chat_models.some(
    (m) => m.provider === settings.chat_provider && m.model === settings.chat_model && m.selectable,
  );
  return { chatConfigured };
}
