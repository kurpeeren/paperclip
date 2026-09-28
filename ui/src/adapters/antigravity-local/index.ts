import type { UIAdapterModule } from "../types";
import {
  buildAntigravityLocalConfig,
  parseAntigravityStdoutLine,
} from "@paperclipai/adapter-antigravity-local/ui";
import { AntigravityLocalConfigFields } from "./config-fields";

export const antigravityLocalUIAdapter: UIAdapterModule = {
  type: "antigravity_local",
  label: "Antigravity",
  parseStdoutLine: parseAntigravityStdoutLine,
  ConfigFields: AntigravityLocalConfigFields,
  buildAdapterConfig: buildAntigravityLocalConfig,
};
