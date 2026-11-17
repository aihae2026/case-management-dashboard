export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      access_log: {
        Row: {
          action: string
          created_at: string | null
          device: string | null
          id: string
          ip: string | null
          org_id: string
          user_id: string | null
          user_name: string | null
        }
        Insert: {
          action?: string
          created_at?: string | null
          device?: string | null
          id?: string
          ip?: string | null
          org_id: string
          user_id?: string | null
          user_name?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          device?: string | null
          id?: string
          ip?: string | null
          org_id?: string
          user_id?: string | null
          user_name?: string | null
        }
        Relationships: []
      }
      closure_reports: {
        Row: {
          case_status: Json | null
          client_id: string
          closure_date: string | null
          closure_reason: string | null
          closure_result: string | null
          closure_type: string | null
          closure_type_detail: string | null
          created_at: string | null
          files: Json | null
          id: string
          org_id: string
          referral_org: string | null
          service_history: Json | null
          updated_at: string | null
          worker_opinion: string | null
          written_by: string | null
        }
        Insert: {
          case_status?: Json | null
          client_id: string
          closure_date?: string | null
          closure_reason?: string | null
          closure_result?: string | null
          closure_type?: string | null
          closure_type_detail?: string | null
          created_at?: string | null
          files?: Json | null
          id?: string
          org_id: string
          referral_org?: string | null
          service_history?: Json | null
          updated_at?: string | null
          worker_opinion?: string | null
          written_by?: string | null
        }
        Update: {
          case_status?: Json | null
          client_id?: string
          closure_date?: string | null
          closure_reason?: string | null
          closure_result?: string | null
          closure_type?: string | null
          closure_type_detail?: string | null
          created_at?: string | null
          files?: Json | null
          id?: string
          org_id?: string
          referral_org?: string | null
          service_history?: Json | null
          updated_at?: string | null
          worker_opinion?: string | null
          written_by?: string | null
        }
        Relationships: []
      }
      companion_ack: {
        Row: {
          session_id: string
          org_id: string | null
          risk_level: string
          acked_by: string | null
          acked_at: string
        }
        Insert: {
          session_id: string
          org_id?: string | null
          risk_level: string
          acked_by?: string | null
          acked_at?: string
        }
        Update: {
          session_id?: string
          org_id?: string | null
          risk_level?: string
          acked_by?: string | null
          acked_at?: string
        }
        Relationships: []
      }
      companion_hidden_sessions: {
        Row: {
          hidden_at: string | null
          hidden_by: string | null
          org_id: string
          session_id: string
        }
        Insert: {
          hidden_at?: string | null
          hidden_by?: string | null
          org_id: string
          session_id: string
        }
        Update: {
          hidden_at?: string | null
          hidden_by?: string | null
          org_id?: string
          session_id?: string
        }
        Relationships: []
      }
      consent_audit_logs: {
        Row: {
          client_id: string
          created_at: string | null
          document_hash: string
          drive_file_id: string | null
          drive_url: string | null
          id: string
          ip_address: string | null
          org_id: string
          signature_strokes: number | null
          signed_at: string
          signer_name: string
          user_agent: string | null
          worker_name: string | null
        }
        Insert: {
          client_id: string
          created_at?: string | null
          document_hash: string
          drive_file_id?: string | null
          drive_url?: string | null
          id?: string
          ip_address?: string | null
          org_id: string
          signature_strokes?: number | null
          signed_at: string
          signer_name: string
          user_agent?: string | null
          worker_name?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string | null
          document_hash?: string
          drive_file_id?: string | null
          drive_url?: string | null
          id?: string
          ip_address?: string | null
          org_id?: string
          signature_strokes?: number | null
          signed_at?: string
          signer_name?: string
          user_agent?: string | null
          worker_name?: string | null
        }
        Relationships: []
      }
      activity_logs: {
        Row: {
          client_id: string
          created_at: string
          id: string
          method: string
          note: string
          org_id: string
          result: string | null
          title: string | null
          transcript: string | null
          worker_name: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          method: string
          note?: string
          org_id: string
          result?: string | null
          title?: string | null
          transcript?: string | null
          worker_name?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          method?: string
          note?: string
          org_id?: string
          result?: string | null
          title?: string | null
          transcript?: string | null
          worker_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_reports: {
        Row: {
          analyzed_at: string
          content: string
          id: string
          org_id: string
          report_key: string
          via: string
          worker_name: string | null
        }
        Insert: {
          analyzed_at?: string
          content: string
          id?: string
          org_id: string
          report_key: string
          via?: string
          worker_name?: string | null
        }
        Update: {
          analyzed_at?: string
          content?: string
          id?: string
          org_id?: string
          report_key?: string
          via?: string
          worker_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_reports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          actor_id: string | null
          actor_name: string | null
          created_at: string
          id: string
          new_data: Json | null
          old_data: Json | null
          op: string
          org_id: string | null
          reverted_at: string | null
          reverted_by: string | null
          reverted_by_name: string | null
          row_id: string | null
          table_name: string
        }
        Insert: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          op: string
          org_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_by_name?: string | null
          row_id?: string | null
          table_name: string
        }
        Update: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          op?: string
          org_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_by_name?: string | null
          row_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      clients: {
        Row: {
          address: string | null
          address_detail: string | null
          ai_consent: string
          birth: string | null
          client_code: string | null
          consent_drive_id: string | null
          consent_drive_url: string | null
          created_at: string
          education: string | null
          gender: string | null
          genogram: string | null
          grade: string | null
          household: string | null
          housing: string | null
          id: string
          last_contact_at: string | null
          last_contact_method: string | null
          name: string
          needs: string[]
          note: string | null
          org_id: string
          phone: string | null
          progress: number
          registered_at: string | null
          risk: string
          rrn_back1: string | null
          rrn_front: string | null
          summary: string | null
          type: string
          updated_at: string
          welfare_status: string | null
          worker_id: string | null
          worker_name: string | null
        }
        Insert: {
          address?: string | null
          address_detail?: string | null
          ai_consent?: string
          birth?: string | null
          client_code?: string | null
          consent_drive_id?: string | null
          consent_drive_url?: string | null
          created_at?: string
          education?: string | null
          gender?: string | null
          genogram?: string | null
          grade?: string | null
          household?: string | null
          housing?: string | null
          id?: string
          last_contact_at?: string | null
          last_contact_method?: string | null
          name: string
          needs?: string[]
          note?: string | null
          org_id: string
          phone?: string | null
          progress?: number
          registered_at?: string | null
          risk?: string
          rrn_back1?: string | null
          rrn_front?: string | null
          summary?: string | null
          type: string
          updated_at?: string
          welfare_status?: string | null
          worker_id?: string | null
          worker_name?: string | null
        }
        Update: {
          address?: string | null
          address_detail?: string | null
          ai_consent?: string
          birth?: string | null
          client_code?: string | null
          consent_drive_id?: string | null
          consent_drive_url?: string | null
          created_at?: string
          education?: string | null
          gender?: string | null
          genogram?: string | null
          grade?: string | null
          household?: string | null
          housing?: string | null
          id?: string
          last_contact_at?: string | null
          last_contact_method?: string | null
          name?: string
          needs?: string[]
          note?: string | null
          org_id?: string
          phone?: string | null
          progress?: number
          registered_at?: string | null
          risk?: string
          rrn_back1?: string | null
          rrn_front?: string | null
          summary?: string | null
          type?: string
          updated_at?: string
          welfare_status?: string | null
          worker_id?: string | null
          worker_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      files: {
        Row: {
          client_id: string | null
          created_at: string | null
          drive_file_id: string | null
          drive_url: string | null
          id: string
          mime_type: string | null
          name: string
          org_id: string
          size_bytes: number | null
          uploaded_by: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string | null
          drive_file_id?: string | null
          drive_url?: string | null
          id?: string
          mime_type?: string | null
          name: string
          org_id: string
          size_bytes?: number | null
          uploaded_by?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string | null
          drive_file_id?: string | null
          drive_url?: string | null
          id?: string
          mime_type?: string | null
          name?: string
          org_id?: string
          size_bytes?: number | null
          uploaded_by?: string | null
        }
        Relationships: []
      }
      goals: {
        Row: {
          client_id: string
          created_at: string
          detail: string | null
          id: string
          kind: string
          org_id: string
          progress: number
          source: string
          title: string
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          detail?: string | null
          id?: string
          kind?: string
          org_id: string
          progress?: number
          source?: string
          title: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          detail?: string | null
          id?: string
          kind?: string
          org_id?: string
          progress?: number
          source?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "goals_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      manuals: {
        Row: {
          chunks: Json
          filename: string
          id: string
          org_id: string
          pages: number
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          chunks?: Json
          filename: string
          id?: string
          org_id: string
          pages?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          chunks?: Json
          filename?: string
          id?: string
          org_id?: string
          pages?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "manuals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      manual_sources: {
        Row: {
          id: string
          org_id: string
          type: string
          title: string
          url: string | null
          drive_id: string | null
          drive_url: string | null
          chunks: Json
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          type: string
          title: string
          url?: string | null
          drive_id?: string | null
          drive_url?: string | null
          chunks?: Json
          created_at?: string
        }
        Update: {
          id?: string
          org_id?: string
          type?: string
          title?: string
          url?: string | null
          drive_id?: string | null
          drive_url?: string | null
          chunks?: Json
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "manual_sources_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          client_code_prefix: string | null
          client_seq: number
          client_types: string[]
          created_at: string
          created_by: string | null
          id: string
          join_code: string
          name: string
          org_type: string
          slug: string
        }
        Insert: {
          client_code_prefix?: string | null
          client_seq?: number
          client_types?: string[]
          created_at?: string
          created_by?: string | null
          id?: string
          join_code: string
          name: string
          org_type?: string
          slug?: string
        }
        Update: {
          client_code_prefix?: string | null
          client_seq?: number
          client_types?: string[]
          created_at?: string
          created_by?: string | null
          id?: string
          join_code?: string
          name?: string
          org_type?: string
          slug?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          org_id: string | null
          phone: string | null
          status: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id: string
          name: string
          org_id?: string | null
          phone?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          org_id?: string | null
          phone?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      provisions: {
        Row: {
          agency: string | null
          category: string
          client_id: string
          created_at: string
          id: string
          note: string | null
          org_id: string
          provided_at: string
          quantity: string | null
          title: string
        }
        Insert: {
          agency?: string | null
          category: string
          client_id: string
          created_at?: string
          id?: string
          note?: string | null
          org_id: string
          provided_at?: string
          quantity?: string | null
          title: string
        }
        Update: {
          agency?: string | null
          category?: string
          client_id?: string
          created_at?: string
          id?: string
          note?: string | null
          org_id?: string
          provided_at?: string
          quantity?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "provisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provisions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          org_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      view_log: {
        Row: {
          action: string
          client_code: string | null
          client_id: string | null
          created_at: string
          detail: string | null
          device: string | null
          id: string
          ip: string | null
          org_id: string
          user_id: string | null
          user_name: string | null
        }
        Insert: {
          action: string
          client_code?: string | null
          client_id?: string | null
          created_at?: string
          detail?: string | null
          device?: string | null
          id?: string
          ip?: string | null
          org_id: string
          user_id?: string | null
          user_name?: string | null
        }
        Update: {
          action?: string
          client_code?: string | null
          client_id?: string | null
          created_at?: string
          detail?: string | null
          device?: string | null
          id?: string
          ip?: string | null
          org_id?: string
          user_id?: string | null
          user_name?: string | null
        }
        Relationships: []
      }
      worker_handovers: {
        Row: {
          client_ids: string[]
          from_name: string
          id: string
          moved_count: number
          note: string | null
          org_id: string
          performed_at: string
          performed_by: string | null
          performed_by_name: string | null
          skipped_count: number
          to_name: string
          to_user_id: string | null
        }
        Insert: {
          client_ids?: string[]
          from_name: string
          id?: string
          moved_count: number
          note?: string | null
          org_id: string
          performed_at?: string
          performed_by?: string | null
          performed_by_name?: string | null
          skipped_count?: number
          to_name: string
          to_user_id?: string | null
        }
        Update: {
          client_ids?: string[]
          from_name?: string
          id?: string
          moved_count?: number
          note?: string | null
          org_id?: string
          performed_at?: string
          performed_by?: string | null
          performed_by_name?: string | null
          skipped_count?: number
          to_name?: string
          to_user_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      handover_clients: {
        Args: { p_client_ids: string[]; p_from: string; p_note?: string; p_to_user: string }
        Returns: Json
      }
      companion_lookup: {
        Args: {
          p_join_code: string
          p_name: string
          p_phone: string
          p_secret: string
        }
        Returns: Json
      }
      current_org_id: { Args: never; Returns: string }
      delete_user: { Args: never; Returns: undefined }
      gen_join_code: { Args: never; Returns: string }
      has_role: {
        Args: {
          _org_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_viewer: { Args: never; Returns: boolean }
      join_org_by_code: {
        Args: { _code: string }
        Returns: {
          client_types: string[]
          id: string
          name: string
          org_type: string
        }[]
      }
      list_org_names: {
        Args: never
        Returns: {
          id: string
          name: string
        }[]
      }
      patch_client_extra: {
        Args: { p_address_detail?: string; p_household?: string; p_id: string }
        Returns: undefined
      }
      remove_org_member: { Args: { target: string }; Returns: undefined }
      restore_deleted: { Args: { _audit_id: string }; Returns: undefined }
      revert_audit: { Args: { _audit_id: string }; Returns: undefined }
    }
    Enums: {
      app_role: "admin" | "member" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "member", "viewer"],
    },
  },
} as const
