import { useId, useRef, useState, type ChangeEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Camera, LoaderCircle, Trash2 } from "lucide-react";
import { assetsApi } from "../api/assets";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { AgentAvatar, type AvatarAgent } from "./AgentAvatar";

export const AGENT_AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/**
 * Upload, change, or remove an agent's avatar image. The field only reports the
 * uploaded asset id; the caller decides when to save it on the agent.
 */
export function AgentAvatarField({
  agent,
  value,
  onChange,
  disabled = false,
}: {
  agent: AvatarAgent & { id: string };
  value: string | null;
  onChange: (assetId: string | null) => void;
  disabled?: boolean;
}) {
  const { selectedCompanyId } = useCompany();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("Select an organization to upload an avatar.");
      return assetsApi.uploadImage(selectedCompanyId, file, `agents/${agent.id}/avatar`);
    },
    onSuccess: (asset) => {
      setError(null);
      onChange(asset.assetId);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Avatar upload failed.");
    },
  });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!AGENT_AVATAR_ACCEPT.split(",").includes(file.type.toLowerCase())) {
      setError("Upload a PNG, JPEG, WEBP, or GIF image.");
      return;
    }
    upload.mutate(file);
  }

  const busy = disabled || upload.isPending || !selectedCompanyId;
  return (
    <div className="flex items-center gap-3">
      <AgentAvatar agent={{ ...agent, avatarAssetId: value }} size={48} />
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={AGENT_AVATAR_ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={handleFileChange}
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
            {upload.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
            {value ? "Change photo" : "Upload photo"}
          </Button>
          {value ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                onChange(null);
              }}
              disabled={busy}
            >
              <Trash2 className="size-4" />
              Remove
            </Button>
          ) : null}
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
