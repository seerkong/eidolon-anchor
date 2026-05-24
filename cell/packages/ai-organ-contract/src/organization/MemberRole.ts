export const BUILTIN_MEMBER_ROLES = {
  primary: "primary",
  worker: "worker",
} as const;

export type BuiltinMemberRole = (typeof BUILTIN_MEMBER_ROLES)[keyof typeof BUILTIN_MEMBER_ROLES];

export type MemberRole = string;

export function normalizeMemberRole(role: unknown): MemberRole {
  const text = String(role ?? "").trim();
  if (!text) {
    return BUILTIN_MEMBER_ROLES.worker;
  }
  return text;
}
