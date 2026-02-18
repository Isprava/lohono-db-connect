export interface AclConfig {
  default_policy: "open" | "deny";
  public_tools: string[];
  disabled_tools: string[];
  tool_acls: Record<string, string[]>;
}

export interface AclCheckResult {
  allowed: boolean;
  reason: string;
  user_email?: string;
  user_acls?: string[];
}
