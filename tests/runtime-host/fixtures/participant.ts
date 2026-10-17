import type {ParticipantContextCut} from '@cell/ai-runtime-host-contract'
export const emptyContext=():ParticipantContextCut=>({schemaVersion:'bridge.im-context/v1',cutId:'test-empty-cut',messages:[]})
