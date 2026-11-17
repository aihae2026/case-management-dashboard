import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Mic, Send, Square, Volume2, Loader2, PhoneCall, X } from "lucide-react";
import type { StoredMessage } from "@/lib/chat.functions";
import { kstDate } from "@/lib/utils";
import { unlockAudio } from "@/lib/audio-unlock";
import { classifyCrisis, CRISIS_NOTICE, type CrisisKind } from "@/lib/crisis-keywords";
import {
  fetchWeatherCheckin,
  markWeatherCheckinShown,
  weatherCheckinAlreadyShownToday,
  type WeatherCheckin,
} from "@/lib/weather";


const QUICK_REPLIES = [
  "네, 좋아요 😊",
  "아니요",
  "밥 먹었어요 🍚",
  "몸이 아파요 🤕",
  "고마워요 🙏",
  "심심해요 😔",
];

// 화면이 응답을 기다리는 최대 시간. 글자가 이만큼 안 오면 끊고 다시 말씀하시게 한다.
const STALL_MS = 30_000;

function textOf(message: UIMessage): string {
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

function toUiMessages(history: StoredMessage[]): UIMessage[] {
  return history.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text", text: m.content }],
  }));
}

function formatDateDivider(dateStr: string): string {
  // dateStr: 한국 시간 기준 "YYYY-MM-DD"
  const d = new Date(`${dateStr}T12:00:00+09:00`);
  return d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Seoul",
  });
}

function formatTime(iso: string): string {
  // ISO → "오전 H:MM" / "오후 H:MM" (한국 시간)
  const d = new Date(iso);
  return d.toLocaleTimeString("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Seoul",
  });
}

export function ChatWindow({
  sessionId,
  initialHistory,
  companionName,
  seniorName,
  avatarSrc,
  voiceName = "Puck",
  speechRate = 1.0,
  volume = 1.0,
  staffPhone,
  staffName,
  onRevoked,
}: {
  sessionId: string;   // (S-1/S-2) TTS 인증에도 사용
  initialHistory: StoredMessage[];
  companionName: string;
  seniorName: string;
  avatarSrc: string;
  voiceName?: string;
  speechRate?: number;
  volume?: number;
  staffPhone?: string;
  staffName?: string;
  onRevoked?: () => void; // 서버가 "승인 안 됨"으로 거절했을 때 (해제·삭제)
}) {
  // ID → ISO 날짜 맵 (initialHistory 기반, 새 메시지는 현재 시각으로 채움)
  const msgDateMap = useRef<Map<string, string>>(
    new Map(initialHistory.map((m) => [m.id, m.created_at])),
  );

  const nameRef = useRef(companionName);
  const seniorRef = useRef(seniorName);
  useEffect(() => {
    nameRef.current = companionName;
  }, [companionName]);
  useEffect(() => {
    seniorRef.current = seniorName;
  }, [seniorName]);

  const onRevokedRef = useRef(onRevoked);
  useEffect(() => {
    onRevokedRef.current = onRevoked;
  }, [onRevoked]);

  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<() => void>(() => {}); // (R-H4) stale closure 방지
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const retryAttemptsRef = useRef(0); // 사용자가 새로 말하기 전까지 자동 재시도한 횟수

  // 어르신의 마지막 말씀이 위기 신호이고 AI가 답하지 못했을 때, 일반 오류 문구 대신 보여 주는 고정 안내문
  const [crisisKind, setCrisisKind] = useState<CrisisKind | null>(null);
  const lastUserTextRef = useRef(""); // onError가 오래된 값을 보지 않도록 ref로 들고 있는다

  // (R-H3) DefaultChatTransport를 useMemo로 안정화 — 매 렌더 재생성 방지
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages: msgs, trigger }) => ({
          body: {
            messages: msgs,
            sessionId,
            companionName: nameRef.current,
            seniorName: seniorRef.current,
            // 재시도(regenerate)는 같은 사용자 메시지를 다시 보내므로 서버가 중복 저장하지 않게 알려준다
            trigger,
          },
        }),
      }),
    // sessionId는 ChatApp의 key={sessionId} remount로 안정적
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { messages, sendMessage, regenerate, stop, setMessages, status } = useChat({
    id: sessionId,
    messages: toUiMessages(initialHistory),
    transport,
    onError: (err) => {
      console.error(err);
      const raw = String((err as Error)?.message ?? err).toLowerCase();
      if (raw.includes("not_approved")) {
        onRevokedRef.current?.();
        return;
      }
      // 너무 긴 말씀: 서버가 거절했다. 위기 안내와 무관하게 안내만 한다.
      if (raw.includes("too_long")) {
        setNotice("말씀이 너무 길어요. 조금 나누어서 말씀해 주세요.");
        return;
      }
      // 위기 신호가 있는 말씀에 AI가 답하지 못했다면 고정 안내문을 먼저 보여 준다 (아래 일반 오류 문구는 띄우지 않는다)
      const crisis = classifyCrisis(lastUserTextRef.current);
      if (crisis) setCrisisKind(crisis);
      const showNotice = (text: string) => { if (!crisis) setNotice(text); };
      // 짧은 시간에 너무 많이 보낸 경우 (서버 속도 제한) — AI 한도와는 다르다
      const isRateLimited = raw.includes("too_many_requests");
      const isQuota =
        raw.includes("429") ||
        raw.includes("quota") ||
        raw.includes("resource_exhausted") ||
        raw.includes("quota_exceeded");
      // 503 과부하: 자동 재시도 (5초 카운트다운, 최대 3번)
      const isOverloaded =
        raw.includes("503") ||
        raw.includes("unavailable") ||
        raw.includes("high demand") ||
        raw.includes("temporarily");
      // 서버가 Gemini 응답을 기다리다 끊었다
      const isTimeout = raw.includes("stream_timeout");
      if (isRateLimited) {
        showNotice("너무 빠르게 보내셨어요. 잠깐 쉬었다가 다시 말씀해 주세요.");
      } else if (isTimeout) {
        showNotice("응답이 늦어지고 있어요. 한 번 더 말씀해 주시겠어요?");
      } else if (isQuota) {
        showNotice("오늘 AI 대화 한도에 도달했어요. 잠시 후 다시 시도해 주세요.");
      } else if (isOverloaded && retryAttemptsRef.current >= 3) {
        showNotice("지금 AI가 많이 바빠요. 잠시 후 다시 말씀해 주세요.");
      } else if (isOverloaded) {
        retryAttemptsRef.current += 1;
        let count = 5;
        setRetryCountdown(count);
        setNotice(null);
        if (retryTimerRef.current) clearInterval(retryTimerRef.current);
        retryTimerRef.current = setInterval(() => {
          count -= 1;
          if (count <= 0) {
            clearInterval(retryTimerRef.current!);
            retryTimerRef.current = null;
            setRetryCountdown(null);
            retryRef.current(); // (R-H4) 최신 regenerate 참조
          } else {
            setRetryCountdown(count);
          }
        }, 1000);
      } else {
        showNotice("잠시 문제가 생겼어요. 다시 한 번 말씀해 주시겠어요?");
      }
    },
  });

  // (R-H4) regenerate가 바뀔 때마다 ref 갱신
  useEffect(() => { retryRef.current = () => { void regenerate(); }; }, [regenerate]);
  // 언마운트 시 타이머 정리
  useEffect(() => () => { if (retryTimerRef.current) clearInterval(retryTimerRef.current); }, []);

  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [weather, setWeather] = useState<WeatherCheckin>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingSpeakId, setLoadingSpeakId] = useState<string | null>(null);
  const [showQuick, setShowQuick] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const busy = status === "submitted" || status === "streaming";

  // 어르신이 마지막으로 한 말씀을 기억해 둔다 (onError·무응답 처리에서 위기 신호를 가릴 때 쓴다)
  useEffect(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    lastUserTextRef.current = lastUser ? textOf(lastUser) : "";
  }, [messages]);

  // 응답이 한참 오지 않으면 끊고 다시 말씀하시게 한다. (멈춘 채로 보내기 버튼이 풀리지 않는 일을 막는다)
  // 글자가 새로 오면(messages가 바뀌면) 시간을 다시 센다.
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => {
      void stop();
      const crisis = classifyCrisis(lastUserTextRef.current);
      if (crisis) setCrisisKind(crisis);
      else setNotice("응답이 늦어지고 있어요. 한 번 더 말씀해 주시겠어요?");
    }, STALL_MS);
    return () => clearTimeout(t);
  }, [busy, messages, stop]);

  // 답이 끝났는데 내용이 비어 있으면 빈 말풍선을 없애고 안내한다. 정상 답이 오면 위기 안내문은 걷는다.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const was = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status !== "ready" || (was !== "streaming" && was !== "submitted")) return;
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return;
    if (!textOf(last).trim()) {
      setMessages((prev) => prev.filter((m) => m.id !== last.id));
      const crisis = classifyCrisis(lastUserTextRef.current);
      if (crisis) setCrisisKind(crisis);
      else setNotice("지금은 답을 드리지 못했어요. 한 번 더 말씀해 주시겠어요?");
    } else {
      setCrisisKind(null);
    }
  }, [status, messages, setMessages]);

  // 날짜 구분선 삽입을 위한 메시지 + 구분선 혼합 배열
  // 새 메시지 타임스탬프는 useMemo 밖에서 커밋 — Strict/Concurrent 모드 안전 (R-M6)
  const [messagesWithDividers, pendingDateEntries] = useMemo(() => {
    type Item =
      | { type: "message"; msg: UIMessage; timestamp: string }
      | { type: "divider"; dateStr: string };
    const result: Item[] = [];
    const newEntries: [string, string][] = [];
    let lastDate = "";
    for (const msg of messages) {
      let iso: string;
      if (msgDateMap.current.has(msg.id)) {
        iso = msgDateMap.current.get(msg.id)!;
      } else {
        iso = new Date().toISOString();
        newEntries.push([msg.id, iso]); // ref mutation은 아래 useLayoutEffect에서
      }
      const dateStr = kstDate(iso); // 한국 시간 기준 "YYYY-MM-DD"
      if (dateStr !== lastDate) {
        result.push({ type: "divider", dateStr });
        lastDate = dateStr;
      }
      result.push({ type: "message", msg, timestamp: formatTime(iso) });
    }
    return [result, newEntries] as const;
  }, [messages]);

  // 새 메시지 타임스탬프를 ref에 커밋 (렌더 완료 후 동기 실행)
  useLayoutEffect(() => {
    for (const [id, iso] of pendingDateEntries) {
      msgDateMap.current.set(id, iso);
    }
  }, [pendingDateEntries]);

  // 카카오톡 메커니즘: 항상 하단 스크롤.
  // justify-end 레이아웃에서 "하단 = 최신 메시지의 시작점"이므로
  // 새 봇 메시지가 와도 시작부터 자연스럽게 보임.
  const lastMsgIdRef = useRef<string | null>(null);
  const newMsgTopRef = useRef<HTMLDivElement | null>(null);

  // 마지막 어시스턴트 메시지 ID — BotBubble containerRef 연결용
  const lastAssistantMsgId = useMemo(() => {
    for (let i = messagesWithDividers.length - 1; i >= 0; i--) {
      const item = messagesWithDividers[i];
      if (item.type === "message" && item.msg.role === "assistant") return item.msg.id;
    }
    return null;
  }, [messagesWithDividers]);

  // 초기 마운트: 이전 대화 내역이 있을 때 하단(최신 메시지)으로 즉시 이동
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const lastMsg = messages[messages.length - 1];

    if (lastMsg?.role === "assistant") {
      if (lastMsg.id !== lastMsgIdRef.current) {
        // 새 봇 메시지 시작 → 메시지 첫 줄로 스크롤 (카카오톡처럼)
        lastMsgIdRef.current = lastMsg.id;
        requestAnimationFrame(() => {
          const el = newMsgTopRef.current;
          const container = scrollRef.current;
          if (el && container) {
            const elTop = el.getBoundingClientRect().top;
            const containerTop = container.getBoundingClientRect().top;
            container.scrollTo({ top: container.scrollTop + (elTop - containerTop), behavior: "instant" as ScrollBehavior });
          }
        });
      }
      // 스트리밍 중 → 자동스크롤 없음 (사용자가 위에서부터 읽을 수 있도록)
      return;
    }

    // 유저 메시지 전송 / 로딩 / 날씨 → 하단으로
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" as ScrollBehavior });
    });
  }, [messages, busy, transcribing, weather]);

  // iOS PWA: 구버전 iOS에서 키보드 열릴 때 dvh가 줄지 않는 문제 보완.
  // visualViewport 크기 변경 시(키보드 열기/닫기) 채팅을 하단으로 즉시 스크롤.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const onResize = () => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" as ScrollBehavior });
      });
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (weatherCheckinAlreadyShownToday()) return;
    fetchWeatherCheckin(nameRef.current).then((result) => {
      if (result) {
        setWeather(result);
        markWeatherCheckinShown();
      }
    });
  }, []);


  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setNotice(null);
      setCrisisKind(null);
      // 503 자동재시도 카운트다운 중이면 취소
      if (retryTimerRef.current) { clearInterval(retryTimerRef.current); retryTimerRef.current = null; }
      setRetryCountdown(null);
      retryAttemptsRef.current = 0;
      setInput("");
      setShowQuick(false);
      void sendMessage({ text: trimmed });
    },
    [busy, sendMessage],
  );

  useEffect(() => {
    return () => {
      fetchAbortRef.current?.abort();
      audioRef.current?.pause();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const speak = useCallback(
    (id: string, text: string) => {
      const cleanup = () => {
        fetchAbortRef.current?.abort();
        const el = audioRef.current;
        if (el) {
          el.pause();
          if (document.body.contains(el)) document.body.removeChild(el);
        }
        audioRef.current = null;
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
      };

      // 같은 버튼 재클릭 → 정지
      if (speakingId === id) {
        cleanup();
        setSpeakingId(null);
        setLoadingSpeakId(null);
        return;
      }

      cleanup();
      setSpeakingId(null);
      setLoadingSpeakId(id);

      // 사용자 제스처 프레임 안에서 Audio element 생성 → HTMLMediaElement autoplay 허용
      const audio = new Audio();
      audio.volume = Math.max(0.1, volume);
      // DOM에 붙여 Chrome이 미디어 세션으로 인식하게 함 (YouTube와 동일 오디오 경로)
      audio.style.display = "none";
      document.body.appendChild(audio);
      audioRef.current = audio;
      // 아이폰 Safari는 소리를 기다린 뒤의 재생을 막으므로, 누른 순간 무음을 먼저 재생해 권한을 열어 둔다
      unlockAudio(audio);

      const controller = new AbortController();
      fetchAbortRef.current = controller;

      fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceName, sessionId }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: "unknown" })) as { error?: string };
            throw new Error(body.error ?? `http_${res.status}`);
          }
          const blob = await res.blob();
          if (blob.size < 50) throw new Error(`empty_audio_${blob.size}b`);

          const el = audioRef.current;
          if (!el) return;

          const blobUrl = URL.createObjectURL(blob);
          el.src = blobUrl;
          el.playbackRate = Math.max(0.5, Math.min(2.0, speechRate));
          el.onended = () => {
            URL.revokeObjectURL(blobUrl);
            if (document.body.contains(el)) document.body.removeChild(el);
            setSpeakingId(null);
            audioRef.current = null;
          };

          // MediaSession 등록 — Chrome이 YouTube처럼 미디어 카테고리로 처리
          if ("mediaSession" in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: "복순이 읽어주기" });
            navigator.mediaSession.playbackState = "playing";
          }

          setSpeakingId(id);
          setLoadingSpeakId(null);
          await el.play();
        })
        .catch((err: unknown) => {
          if ((err as Error)?.name === "AbortError") return;
          setSpeakingId(null);
          setLoadingSpeakId(null);
          console.error("[tts] failed:", err);
          if (String((err as Error)?.message).includes("not_approved")) {
            onRevokedRef.current?.();
            return;
          }
          setNotice("소리를 들려드리지 못했어요. 잠시 후 다시 눌러 주세요.");
        });
    },
    [speakingId, voiceName, sessionId, speechRate, volume],
  );

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(() => {
    setNotice(null);

    // 브라우저 내장 음성 인식 (SpeechRecognition API — 서버 불필요, 무료, 한국어 지원)
    const SR = (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (!SR) {
      setNotice("이 기기에서는 마이크 입력을 사용할 수 없어요. 아래 글자판으로 적어 주세요.");
      return;
    }

    // 브라우저 음성 인식 API는 TypeScript 기본 타입에 없어서 쓰는 부분만 직접 선언한다
    type SpeechRecognitionLike = {
      lang: string;
      interimResults: boolean;
      maxAlternatives: number;
      onstart: (() => void) | null;
      onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript?: string }>> }) => void) | null;
      onerror: ((event: { error: string }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    const recognition = new (SR as new () => SpeechRecognitionLike)();
    recognition.lang = "ko-KR";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    // mediaRecorderRef를 SpeechRecognition 참조로 재활용 (stopRecording에서 .stop() 호출됨)
    mediaRecorderRef.current = recognition as unknown as MediaRecorder;

    recognition.onstart = () => setRecording(true);

    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript?.trim();
      if (text) {
        submit(text);
      } else {
        setNotice("말씀을 알아듣지 못했어요. 다시 한 번 말씀해 주시겠어요?");
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech") {
        setNotice("소리가 들리지 않았어요. 다시 한 번 눌러서 말씀해 주세요.");
      } else if (event.error === "not-allowed") {
        setNotice("마이크를 사용할 수 없어요. 아래 글자판으로 말씀을 적어 주세요.");
      } else {
        setNotice("연결이 잠시 끊겼어요. 다시 한 번 눌러 주세요.");
      }
      setRecording(false);
    };

    recognition.onend = () => setRecording(false);

    recognition.start();
  }, [submit]);

  // 이름 끝 1~2자리 숫자 제거 (테스트용 구분자 숨김, DB 원본은 유지)
  const displaySeniorName = seniorName.replace(/\d{1,2}$/, "").trim();
  const seniorLabel = displaySeniorName ? `${displaySeniorName} 어르신` : "어르신";
  const welcome = `안녕하세요, ${seniorLabel}.\n저는 ${seniorLabel} 곁을 지키는 말벗 ${companionName}예요. 😊\n오늘 하루는 어떻게 보내고 계세요?`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Conversation — 카카오톡 메커니즘: 메시지가 하단부터 쌓임
          min-h-full + justify-end는 Safari overflow-y:auto 안에서 min-height:100%가
          0으로 계산되는 버그가 있어, flex-1 spacer 방식으로 대체함 */}
      <div ref={scrollRef} className="min-h-0 flex-1 flex flex-col overflow-y-auto overscroll-contain bg-chat-bg px-3 py-3">
        {/* spacer: 메시지가 적을 때 위 공간을 채워 메시지를 하단으로 밀어냄.
            메시지가 많아 overflow 시 flex-shrink:1로 자동으로 0이 됨 */}
        <div className="flex-1" aria-hidden />
        <div className="flex w-full shrink-0 flex-col gap-2.5">
          <BotBubble
            id="welcome"
            text={welcome}
            avatarSrc={avatarSrc}
            companionName={companionName}
            onSpeak={speak}
            speakingId={speakingId}
            loadingSpeakId={loadingSpeakId}
          />

          {weather && (
            <BotBubble
              id="weather"
              text={weather.message}
              avatarSrc={avatarSrc}
              companionName={companionName}
              highlight
              onSpeak={speak}
              speakingId={speakingId}
              loadingSpeakId={loadingSpeakId}
            />
          )}

          {messagesWithDividers.map((item, idx) =>
            item.type === "divider" ? (
              <DateDivider key={`divider-${item.dateStr}-${idx}`} dateStr={item.dateStr} />
            ) : item.msg.role === "assistant" ? (
              <BotBubble
                key={item.msg.id}
                id={item.msg.id}
                text={textOf(item.msg)}
                avatarSrc={avatarSrc}
                companionName={companionName}
                timestamp={item.timestamp}
                onSpeak={speak}
                speakingId={speakingId}
                loadingSpeakId={loadingSpeakId}
                containerRef={item.msg.id === lastAssistantMsgId ? newMsgTopRef : undefined}
              />
            ) : (
              <UserBubble key={item.msg.id} text={textOf(item.msg)} timestamp={item.timestamp} />
            ),
          )}

          {(busy || transcribing) && (
            <TypingBubble avatarSrc={avatarSrc} label={transcribing ? "듣고 있어요" : undefined} />
          )}

          {retryCountdown !== null && (
            <p className="rounded-2xl bg-amber-100 px-4 py-3 text-center text-[0.9em] font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              복순이 서버가 잠시 바빠요~ {retryCountdown}초 후 자동으로 다시 시도할게요.
            </p>
          )}

          {notice && (
            <p className="rounded-2xl bg-destructive/12 px-4 py-3 text-center text-[0.9em] font-semibold text-destructive">
              {notice}
            </p>
          )}

          {crisisKind && (
            <p
              role="alert"
              className="rounded-2xl bg-amber-100 px-4 py-3 text-center text-[0.95em] font-bold leading-relaxed text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
            >
              {CRISIS_NOTICE[crisisKind]}
            </p>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border bg-card px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2">
        <div className="w-full">
          {/* Utility row: welfare call + quick reply toggle */}
          <div className="mb-2 flex items-center gap-2">
            {/* 번호가 없으면 눌러도 아무 일 없는 죽은 버튼이 되므로 보여주지 않는다 */}
            {staffPhone && (
              <a
                href={`tel:${staffPhone}`}
                className="flex min-h-[2.75rem] min-w-0 shrink items-center gap-1.5 rounded-full border-2 border-primary bg-secondary px-3 py-1.5 text-[0.78em] font-extrabold text-foreground active:scale-95"
                aria-label={`담당 선생님 전화 ${staffPhone}`}
              >
                <PhoneCall className="size-[1em] shrink-0 text-primary" aria-hidden />
                <span className="truncate">{staffName ? `${staffName} 선생님` : "복지관 전화"}</span>
              </a>
            )}
            <button
              type="button"
              onClick={() => setShowQuick((v) => !v)}
              className="min-h-[2.75rem] flex-1 whitespace-nowrap rounded-full border-2 border-border bg-quick px-3 py-1.5 text-[0.78em] font-bold text-quick-foreground active:scale-95"
            >
              {showQuick ? "빠른 답장 닫기" : "빠른 답장 열기 💬"}
            </button>
          </div>

          {showQuick && (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
              {QUICK_REPLIES.map((reply) => (
                <button
                  key={reply}
                  type="button"
                  disabled={busy || recording || transcribing}
                  onClick={() => submit(reply)}
                  className="min-h-[2.75rem] shrink-0 rounded-full border-2 border-border bg-quick px-3.5 py-1.5 text-[0.85em] font-bold text-quick-foreground transition active:scale-95 disabled:opacity-50"
                >
                  {reply}
                </button>
              ))}
            </div>
          )}

          {/* Mic button */}
          <button
            type="button"
            disabled={busy || transcribing}
            onClick={recording ? stopRecording : startRecording}
            style={recording ? { animation: "mic-pulse 1.4s ease-out infinite" } : undefined}
            className={`mb-2 flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-[1em] font-extrabold text-mic-foreground shadow-sm transition active:scale-[0.98] disabled:opacity-50 ${
              recording ? "bg-mic-active" : "bg-mic"
            }`}
          >
            {recording ? (
              <>
                <Square className="size-[1.1em] fill-current" aria-hidden />
                다 말했어요
              </>
            ) : (
              <>
                <Mic className="size-[1.2em]" aria-hidden />
                {transcribing ? "글자로 옮기는 중이에요…" : "눌러서 말하기"}
              </>
            )}
          </button>

          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
              onFocus={() => {
                // iOS: 키보드 애니메이션(~300ms) 후 채팅 하단으로 스크롤
                setTimeout(() => {
                  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" as ScrollBehavior });
                }, 320);
              }}
              rows={1}
              maxLength={2000}
              placeholder="여기를 누르면 글자로 적을 수 있어요"
              disabled={recording}
              className="max-h-28 min-h-[2.75rem] flex-1 resize-none rounded-2xl border-2 border-border bg-background px-3 py-2 text-[0.95em] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <button
              type="button"
              onClick={() => submit(input)}
              disabled={busy || !input.trim()}
              aria-label="보내기"
              className="flex h-[2.75rem] shrink-0 items-center gap-1 rounded-2xl bg-primary px-4 text-[0.95em] font-extrabold text-primary-foreground transition active:scale-95 disabled:opacity-40"
            >
              <Send className="size-[1.1em]" aria-hidden />
              보내기
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}

function BotBubble({
  id,
  text,
  avatarSrc,
  companionName,
  highlight,
  timestamp,
  onSpeak,
  speakingId,
  loadingSpeakId,
  containerRef,
}: {
  id: string;
  text: string;
  avatarSrc: string;
  companionName: string;
  highlight?: boolean;
  timestamp?: string;
  onSpeak: (id: string, text: string) => void;
  speakingId: string | null;
  loadingSpeakId: string | null;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const isSpeaking = speakingId === id;
  const isLoading = loadingSpeakId === id;
  return (
    <div ref={containerRef} className="flex items-end gap-2" style={{ animation: "soft-pop 0.2s ease-out" }}>
      {/* 아바타 — 카카오톡처럼 말풍선 왼쪽 하단 정렬 */}
      <img
        src={avatarSrc}
        alt={companionName}
        loading="lazy"
        className="mb-0.5 size-[2.2em] shrink-0 rounded-full bg-secondary object-cover"
        style={{ animation: "avatar-bob 3.2s ease-in-out infinite" }}
      />
      <div className="flex max-w-[78%] flex-col items-start gap-1">
        {/* 말풍선 + 시간 나란히 */}
        <div className="flex items-end gap-1.5">
          <div
            className={`whitespace-pre-wrap rounded-2xl rounded-tl-sm px-4 py-2.5 text-[1em] leading-relaxed shadow-sm ${
              highlight
                ? "bg-accent text-accent-foreground ring-2 ring-primary/40"
                : "bg-bot-bubble text-bot-bubble-foreground"
            }`}
          >
            {text}
          </div>
          {timestamp && (
            <span className="shrink-0 self-end text-[0.75em] leading-none text-muted-foreground pb-0.5">
              {timestamp}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onSpeak(id, text)}
          className="flex min-h-[2.75rem] items-center gap-1.5 rounded-full bg-secondary/80 px-4 py-1 text-[0.85em] font-bold text-secondary-foreground active:scale-95"
        >
          {isLoading ? (
            <Loader2 className="size-[1em] animate-spin" aria-hidden />
          ) : (
            <Volume2 className="size-[1em]" aria-hidden />
          )}
          {isSpeaking ? "그만 듣기" : "읽어 주기"}
        </button>
      </div>
    </div>
  );
}

function UserBubble({ text, timestamp }: { text: string; timestamp?: string }) {
  return (
    <div className="flex justify-end items-end gap-1.5" style={{ animation: "soft-pop 0.2s ease-out" }}>
      {timestamp && (
        <span className="shrink-0 self-end text-[0.75em] leading-none text-muted-foreground pb-0.5">
          {timestamp}
        </span>
      )}
      {/* 카카오톡 노란 말풍선 */}
      <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-user-bubble px-4 py-2.5 text-[1em] leading-relaxed text-user-bubble-foreground shadow-sm">
        {text}
      </div>
    </div>
  );
}

function DateDivider({ dateStr }: { dateStr: string }) {
  return (
    /* 카카오톡 날짜 구분선 스타일 */
    <div className="flex items-center justify-center py-2" aria-hidden>
      <span className="rounded-full bg-black/10 px-3 py-1 text-[0.7em] font-medium text-foreground/50">
        {formatDateDivider(dateStr)}
      </span>
    </div>
  );
}

function TypingBubble({ avatarSrc, label }: { avatarSrc: string; label?: string }) {
  return (
    <div className="flex items-end gap-2">
      <img
        src={avatarSrc}
        alt=""
        loading="lazy"
        className="mb-0.5 size-[2.2em] shrink-0 rounded-full bg-secondary object-cover"
        style={{ animation: "avatar-bob 3.2s ease-in-out infinite" }}
      />
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-bot-bubble px-4 py-3 shadow-sm">
        {label && <span className="text-[0.82em] font-semibold text-muted-foreground">{label}</span>}
        <span className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-2 rounded-full bg-muted-foreground"
              style={{ animation: `typing-dot 1.2s ease-in-out ${i * 0.18}s infinite` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
