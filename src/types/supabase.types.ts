/**
 * Supabase database types — these match the SQL schema in db/migrations/001_slack_schema.sql.
 * Use these for all Supabase client calls to get full type safety.
 *
 * Structure follows the standard Supabase generated type pattern:
 *   Database['public']['Tables']['table_name']['Row']   — SELECT
 *   Database['public']['Tables']['table_name']['Insert'] — INSERT
 *   Database['public']['Tables']['table_name']['Update'] — UPDATE
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      slack_workspaces: {
        Row: {
          id: string;                   // UUID (internal PK)
          slack_team_id: string;        // Slack team_id e.g. T01234ABC (UNIQUE)
          name: string;
          domain: string;
          icon_url: string | null;
          bot_user_id: string;
          bot_token: string;            // Encrypted xoxb- token
          installed_by_user_id: string; // Slack user ID of installer
          app_id: string;
          scope: string;
          is_active: boolean;
          installed_at: string;         // ISO timestamp
          updated_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          slack_team_id: string;
          name: string;
          domain: string;
          icon_url?: string | null;
          bot_user_id: string;
          bot_token: string;
          installed_by_user_id: string;
          app_id: string;
          scope: string;
          is_active?: boolean;
          installed_at?: string;
          updated_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          slack_team_id?: string;
          name?: string;
          domain?: string;
          icon_url?: string | null;
          bot_user_id?: string;
          bot_token?: string;
          installed_by_user_id?: string;
          app_id?: string;
          scope?: string;
          is_active?: boolean;
          installed_at?: string;
          updated_at?: string;
          created_at?: string;
        };
      };

      slack_channels: {
        Row: {
          id: string;                   // UUID (internal PK)
          workspace_id: string;         // FK → slack_workspaces.id
          slack_channel_id: string;     // C01234ABC (UNIQUE per workspace)
          name: string;
          type: 'public_channel' | 'private_channel' | 'mpim' | 'im';
          is_archived: boolean;
          is_member: boolean;
          topic: string | null;
          purpose: string | null;
          member_count: number | null;
          last_synced_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          slack_channel_id: string;
          name: string;
          type: 'public_channel' | 'private_channel' | 'mpim' | 'im';
          is_archived?: boolean;
          is_member?: boolean;
          topic?: string | null;
          purpose?: string | null;
          member_count?: number | null;
          last_synced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          slack_channel_id?: string;
          name?: string;
          type?: 'public_channel' | 'private_channel' | 'mpim' | 'im';
          is_archived?: boolean;
          is_member?: boolean;
          topic?: string | null;
          purpose?: string | null;
          member_count?: number | null;
          last_synced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };

      slack_messages: {
        Row: {
          id: string;                   // UUID (internal PK)
          workspace_id: string;         // FK → slack_workspaces.id
          channel_id: string;           // FK → slack_channels.id
          slack_ts: string;             // Slack timestamp (unique per channel)
          slack_user_id: string;        // U01234ABC (not FK — user may not be synced yet)
          text: string;
          subtype: string | null;
          thread_ts: string | null;
          reply_count: number;
          reactions: Json;              // JSONB
          files: Json;                  // JSONB
          blocks: Json;                 // JSONB
          edited_at: string | null;
          slack_created_at: string;     // Derived from slack_ts
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          channel_id: string;
          slack_ts: string;
          slack_user_id: string;
          text: string;
          subtype?: string | null;
          thread_ts?: string | null;
          reply_count?: number;
          reactions?: Json;
          files?: Json;
          blocks?: Json;
          edited_at?: string | null;
          slack_created_at: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          channel_id?: string;
          slack_ts?: string;
          slack_user_id?: string;
          text?: string;
          subtype?: string | null;
          thread_ts?: string | null;
          reply_count?: number;
          reactions?: Json;
          files?: Json;
          blocks?: Json;
          edited_at?: string | null;
          slack_created_at?: string;
          created_at?: string;
          updated_at?: string;
        };
      };

      slack_users: {
        Row: {
          id: string;                   // UUID (internal PK)
          workspace_id: string;         // FK → slack_workspaces.id
          slack_user_id: string;        // U01234ABC
          name: string;
          real_name: string;
          display_name: string;
          email: string | null;
          avatar_url: string | null;
          is_bot: boolean;
          is_admin: boolean;
          is_deleted: boolean;
          timezone: string | null;
          last_synced_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          slack_user_id: string;
          name: string;
          real_name: string;
          display_name: string;
          email?: string | null;
          avatar_url?: string | null;
          is_bot?: boolean;
          is_admin?: boolean;
          is_deleted?: boolean;
          timezone?: string | null;
          last_synced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          slack_user_id?: string;
          name?: string;
          real_name?: string;
          display_name?: string;
          email?: string | null;
          avatar_url?: string | null;
          is_bot?: boolean;
          is_admin?: boolean;
          is_deleted?: boolean;
          timezone?: string | null;
          last_synced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
    };

    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}

// ─── Convenience aliases ──────────────────────────────────────────────────────

export type WorkspaceRow = Database['public']['Tables']['slack_workspaces']['Row'];
export type WorkspaceInsert = Database['public']['Tables']['slack_workspaces']['Insert'];
export type WorkspaceUpdate = Database['public']['Tables']['slack_workspaces']['Update'];

export type ChannelRow = Database['public']['Tables']['slack_channels']['Row'];
export type ChannelInsert = Database['public']['Tables']['slack_channels']['Insert'];
export type ChannelUpdate = Database['public']['Tables']['slack_channels']['Update'];

export type MessageRow = Database['public']['Tables']['slack_messages']['Row'];
export type MessageInsert = Database['public']['Tables']['slack_messages']['Insert'];
export type MessageUpdate = Database['public']['Tables']['slack_messages']['Update'];

export type UserRow = Database['public']['Tables']['slack_users']['Row'];
export type UserInsert = Database['public']['Tables']['slack_users']['Insert'];
export type UserUpdate = Database['public']['Tables']['slack_users']['Update'];