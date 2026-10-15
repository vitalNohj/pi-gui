import {
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
  useState,
} from "react";
import {
  type ComposerImageAttachment,
  type DesktopAppState,
  type SessionRecord,
} from "../desktop-state";
import { updateSnapshot } from "../app/desktop-app-state";
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromClipboardData,
  handleClipboardImageShortcut,
  readComposerAttachmentsFromFiles,
} from "../composer-attachments";
import { parseTreeComposerCommand } from "../composer-commands";
import type { PiDesktopApi } from "../ipc";

interface UseSessionComposerParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly selectedSession: SessionRecord | undefined;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerDraftRef: MutableRefObject<string>;
  readonly composerRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly requiresModelSelection: boolean;
  readonly openTreeModal: () => void;
  readonly handleMentionKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly handleSlashKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly newThreadComposerRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly appendNewThreadAttachment: (attachment: ComposerImageAttachment) => void;
  /** Called once a prompt is actually sent (not for cancel/tree commands); used to snap the timeline to the bottom. */
  readonly onSubmitted: () => void;
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

export function useSessionComposer(params: UseSessionComposerParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    selectedSession,
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    composerRef,
    requiresModelSelection,
    openTreeModal,
    handleMentionKeyDown,
    handleSlashKeyDown,
    newThreadComposerRef,
    appendNewThreadAttachment,
    onSubmitted,
  } = params;

  // Attachments optimistically hidden while their submit is in flight. Scoped to the
  // submitted ids (not a blanket flag) because the submit IPC resolves only after the
  // whole agent turn finishes; a blanket flag hid every attachment pasted mid-run.
  const [submittedAttachmentIds, setSubmittedAttachmentIds] = useState<ReadonlySet<string>>(EMPTY_ID_SET);
  const snapshotAttachments = snapshot?.composerAttachments ?? [];
  const composerAttachments = submittedAttachmentIds.size === 0
    ? snapshotAttachments
    : snapshotAttachments.filter((attachment) => !submittedAttachmentIds.has(attachment.id));

  const submitComposerDraft = (options: { readonly deliverAs?: "steer" | "followUp" } = {}) => {
    if (!api || !selectedSession) {
      return;
    }

    const hasComposerInput = composerDraft.trim().length > 0 || composerAttachments.length > 0;
    if (selectedSession.status === "running" && !hasComposerInput) {
      void updateSnapshot(api, setSnapshot, () => api.cancelCurrentRun());
      return;
    }

    if (!hasComposerInput) {
      return;
    }
    if (requiresModelSelection) {
      return;
    }

    const treeCommand = parseTreeComposerCommand(composerDraft);
    if (treeCommand?.type === "error") {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              lastError: treeCommand.message,
            }
          : current,
      );
      return;
    }
    if (treeCommand?.type === "tree") {
      openTreeModal();
      return;
    }

    const previousDraft = composerDraft;
    setComposerDraft("");
    onSubmitted();
    const submittedIds = new Set(composerAttachments.map((attachment) => attachment.id));
    if (submittedIds.size > 0) {
      setSubmittedAttachmentIds(submittedIds);
    }
    void (async () => {
      const nextState = await updateSnapshot(api, setSnapshot, () =>
        api.submitComposer(previousDraft, selectedSession.status === "running" ? { deliverAs: options.deliverAs ?? "followUp" } : undefined),
      );
      // Only apply the resolved draft if the user hasn't typed into the composer during the
      // in-flight submit; otherwise their new input would be clobbered.
      if (composerDraftRef.current === "") {
        setComposerDraft(nextState.composerDraft);
      }
      clearSubmittedAttachmentIds(submittedIds);
    })().catch(() => {
      if (composerDraftRef.current === "") {
        setComposerDraft(previousDraft);
      }
      clearSubmittedAttachmentIds(submittedIds);
    });
  };

  function clearSubmittedAttachmentIds(submittedIds: ReadonlySet<string>) {
    // Only clear our own submit's ids; a newer overlapping submit may own the state now.
    setSubmittedAttachmentIds((current) => (current === submittedIds ? EMPTY_ID_SET : current));
  }

  const handlePickAttachments = () => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.pickComposerAttachments());
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.removeComposerAttachment(attachmentId));
  };

  const handleEditQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.editQueuedComposerMessage(messageId, composerDraft)).then(() => {
      composerRef.current?.focus();
    });
  };

  const handleCancelQueuedEdit = () => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.cancelQueuedComposerEdit()).then(() => {
      composerRef.current?.focus();
    });
  };

  const handleRemoveQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.removeQueuedComposerMessage(messageId));
  };

  const handleSteerQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.steerQueuedComposerMessage(messageId));
  };

  const handleImagePaste = (event: ClipboardEvent<HTMLDivElement>, onFiles: (files: File[]) => void) => {
    const files = extractImageFilesFromClipboardData(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    onFiles(files);
  };

  const handleAttachmentDrop = (event: DragEvent<HTMLDivElement>, onFiles: (files: File[]) => void) => {
    event.preventDefault();
    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    onFiles(files);
  };

  async function addAttachmentsToSessionComposer(files: File[]) {
    if (!api) {
      return;
    }
    const valid = await readComposerAttachmentsFromFiles(files);
    if (valid.length === 0) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.addComposerAttachments(valid));
  }

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    handleImagePaste(event, (files) => {
      void addAttachmentsToSessionComposer(files);
    });
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    handleAttachmentDrop(event, (files) => {
      void addAttachmentsToSessionComposer(files);
    });
  };

  function handlePastedClipboardImage(clipboardImage: ComposerImageAttachment) {
    const activeElement = document.activeElement;
    if (activeElement === composerRef.current) {
      if (!api) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () => api.addComposerAttachments([clipboardImage]));
      return;
    }

    if (activeElement === newThreadComposerRef.current) {
      appendNewThreadAttachment(clipboardImage);
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleClipboardImageShortcut(event, api?.readClipboardImage, (clipboardImage) => {
      if (!api) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () => api.addComposerAttachments([clipboardImage]));
    })) {
      return;
    }

    if (handleMentionKeyDown(event)) {
      return;
    }

    if (handleSlashKeyDown(event)) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && selectedSession?.status === "running") {
      event.preventDefault();
      submitComposerDraft({ deliverAs: (event.metaKey || event.ctrlKey) ? "steer" : "followUp" });
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!composerDraft.trim() && composerAttachments.length === 0) {
      return;
    }
    if (requiresModelSelection) {
      return;
    }

    submitComposerDraft();
  };

  return {
    composerAttachments,
    submitComposerDraft,
    handlePickAttachments,
    handleRemoveAttachment,
    handleEditQueuedMessage,
    handleCancelQueuedEdit,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleComposerPaste,
    handleComposerDrop,
    handlePastedClipboardImage,
    handleComposerKeyDown,
  };
}
