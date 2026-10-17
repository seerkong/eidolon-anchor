import type { AttachmentOperation, HostParticipantSendCommand, HostParticipantPublishedAttachment, HostParticipantAttachmentSettings, HostRequest } from '@cell/ai-runtime-host-contract';
import { AttachmentStoreFailure, createHostAttachmentStore, prepareHostInput } from '@cell/ai-runtime-host-logic';
import type { createAttachmentByteEffects } from '@cell/ai-runtime-host-support';
import { projectParticipantTextInput } from './participantInput';
import { createHash } from 'node:crypto';
const textBytes = 48 * 1024, parts = 16;
type Resources = {
    store: ReturnType<typeof createHostAttachmentStore>;
    bytes: ReturnType<typeof createAttachmentByteEffects>;
    sessionId: string;
    actorId: string;
    epoch: string;
    schema(): unknown;
};
function fail(status: number, code: string): never { throw new AttachmentStoreFailure(status, code); }
/** Reuse the Session resource owner; this adapter only projects admitted text input. */
export function createParticipantAttachments(resources: Resources) {
    const binding = (request: HostRequest) => ({ ...request.principal, sessionId: resources.sessionId, actorId: resources.actorId, epoch: resources.epoch });
    function settings(): {
        attachments?: HostParticipantAttachmentSettings;
        attachmentUnavailableReason?: string;
    } {
        try {
            projectParticipantTextInput(resources.schema(), '');
        }
        catch {
            return { attachmentUnavailableReason: 'participant_text_attachment_schema_unsupported' };
        }
        return { attachments: { epoch: resources.epoch, actorId: resources.actorId, textBytes, parts, mimeTypes: ['text/plain'] } };
    }
    function operate(request: HostRequest, input: AttachmentOperation) {
        if (input.expectedEpoch !== resources.epoch)
            fail(409, 'epoch_mismatch');
        const target = binding(request);
        if (input.kind === 'release')
            return resources.store.release(target, input.attachmentId);
        if (!settings().attachments)
            fail(415, 'participant_text_attachment_schema_unsupported');
        if (input.kind === 'begin') {
            if (input.mime !== 'text/plain')
                fail(415, 'participant_attachment_mime_unsupported');
            if (input.totalBytes > textBytes)
                fail(413, 'participant_attachment_too_large');
            return resources.store.begin(target, input);
        }
        return resources.store.append(target, input.attachmentId, input.offsetBytes, input.data);
    }
    function prepare(request: HostRequest, command: HostParticipantSendCommand) {
        if (command.attachmentEpoch !== resources.epoch)
            fail(409, 'epoch_mismatch');
        if (!settings().attachments)
            fail(415, 'participant_text_attachment_schema_unsupported');
        const lease = prepareHostInput(resources.store, binding(request), command.attachmentIds!.map(attachmentId => ({ type: 'attachment', attachmentId })), resources.bytes);
        try {
            lease.commit();
            const attachments: HostParticipantPublishedAttachment[] = lease.read().map(part => {
                if (part.type !== 'text' || !part.filename || !('sourceDigest' in part) || typeof part.sourceDigest !== 'string')
                    return fail(415, 'participant_attachment_mime_unsupported');
                return { filename: part.filename, mime: 'text/plain', text: part.text, digest: part.sourceDigest };
            });
            return { input: projectMaterial(command.text, attachments), attachments, release: lease.release };
        }
        catch (error) {
            lease.release();
            throw error;
        }
    }
    function prepareMaterial(command: HostParticipantSendCommand) {
        if (!settings().attachments) fail(415, 'participant_text_attachment_schema_unsupported');
        const attachments = command.attachments!.map(file => ({ ...file }));
        if (!attachments.length || attachments.length > parts) fail(413, 'participant_attachment_too_large');
        for (const file of attachments) {
            if (file.mime !== 'text/plain' || 'sha256:' + createHash('sha256').update(file.text).digest('hex') !== file.digest)
                fail(400, 'participant_attachment_digest_mismatch');
        }
        return { input: projectMaterial(command.text, attachments), attachments, release() {} };
    }
    function projectMaterial(text: string, attachments: readonly HostParticipantPublishedAttachment[]): unknown {
        if (attachments.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) > textBytes)
            fail(413, 'participant_attachment_too_large');
        const input = text + '\n\n附件（用户提供的 UTF-8 文本）：\n' + JSON.stringify(attachments.map(({ filename, text }) => ({ filename, text })));
        if (Buffer.byteLength(input) > 65536) fail(413, 'participant_attachment_input_too_large');
        return projectParticipantTextInput(resources.schema(), input);
    }
    return { settings, operate, prepare, prepareMaterial };
}
