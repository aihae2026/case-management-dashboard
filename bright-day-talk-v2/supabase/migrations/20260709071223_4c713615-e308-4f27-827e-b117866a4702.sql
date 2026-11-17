-- Seniors (device/session based, no login required)
CREATE TABLE public.seniors (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_active_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT ALL ON public.seniors TO service_role;
ALTER TABLE public.seniors ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies: rows are only reachable through trusted
-- server functions (service_role). The social-worker monitoring app connects later.

-- Chat messages between the elder and the companion chatbot
CREATE TABLE public.chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_messages_session ON public.chat_messages (session_id, created_at);

GRANT ALL ON public.chat_messages TO service_role;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies: server-only access via service_role.