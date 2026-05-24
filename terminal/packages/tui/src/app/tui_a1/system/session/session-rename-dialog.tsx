import { DialogPrompt } from "../../../../ui/dialog/prompt"
import { useDialog } from "../../../../ui/dialog/context"
import { useSync } from "../../state/sync-context"
import { createMemo } from "solid-js"
import { useRuntimeClient } from "../../../../providers/runtime-client"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useRuntimeClient()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      onConfirm={async (value) => {
        await sdk.client.session.update({
          sessionID: props.session,
          title: value,
        })
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
