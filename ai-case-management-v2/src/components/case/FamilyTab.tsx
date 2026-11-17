import { useState } from "react";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { splitNote, joinNote, type FamilyMember, type Client } from "@/lib/case-types";
import { supabase } from "@/integrations/supabase/client";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

const EMPTY: Omit<FamilyMember, "id"> = {
  name: "", relation: "", birth: "", occupation: "", phone: "", cohabit: "", memo: "",
};

const RELATION_PRESETS = ["배우자", "딸", "아들", "자녀", "부모", "형제·자매", "손자·손녀", "기타"];
const COHABIT_PRESETS = ["동거", "비동거"];

export function FamilyTab({ client, onChanged }: { client: Client; onChanged: () => void }) {
  const parsed = splitNote(client.note);
  const members = parsed.familyMembers;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<FamilyMember | null>(null);
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<Omit<FamilyMember, "id">>(EMPTY);
  const [busy, setBusy] = useState(false);

  async function save(next: FamilyMember[]) {
    setBusy(true);
    const newNote = joinNote(
      parsed.note, parsed.reassessments, parsed.goalAnalysis,
      parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, next,
    );
    const { error } = await supabase.from("clients").update({ note: newNote } as never).eq("id", client.id);
    setBusy(false);
    if (error) { toast.error(error.message); return false; }
    onChanged();
    return true;
  }

  async function addMember() {
    if (!newRow.name.trim()) { toast.error("성명을 입력하세요."); return; }
    const member: FamilyMember = { id: uid(), ...newRow };
    if (await save([...members, member])) {
      setNewRow(EMPTY);
      setAdding(false);
      toast.success("가족관계가 추가됐습니다.");
    }
  }

  async function updateMember() {
    if (!editRow) return;
    if (!editRow.name.trim()) { toast.error("성명을 입력하세요."); return; }
    const next = members.map((m) => (m.id === editRow.id ? editRow : m));
    if (await save(next)) {
      setEditingId(null);
      setEditRow(null);
      toast.success("수정됐습니다.");
    }
  }

  async function deleteMember(id: string) {
    if (!confirm("이 가족관계 항목을 삭제하시겠습니까?")) return;
    const next = members.filter((m) => m.id !== id);
    if (await save(next)) toast.success("삭제됐습니다.");
  }

  function startEdit(m: FamilyMember) {
    setEditingId(m.id);
    setEditRow({ ...m });
    setAdding(false);
  }

  function cancelEdit() { setEditingId(null); setEditRow(null); }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">가족 및 주요 관계인을 등록하세요.</p>
        {!adding && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs"
            onClick={() => { setAdding(true); cancelEdit(); }}>
            <Plus className="h-3.5 w-3.5" />추가
          </Button>
        )}
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              {["성명", "관계", "생년월일", "동거", "직업", "연락처", "비고", ""].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && !adding && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  등록된 가족관계가 없습니다.
                </td>
              </tr>
            )}
            {members.map((m) =>
              editingId === m.id && editRow ? (
                <tr key={m.id} className="border-b bg-accent/20">
                  <td className="px-2 py-1.5">
                    <Input value={editRow.name} onChange={(e) => setEditRow({ ...editRow, name: e.target.value })}
                      className="h-7 text-xs" placeholder="성명" />
                  </td>
                  <td className="px-2 py-1.5">
                    <select value={editRow.relation}
                      onChange={(e) => setEditRow({ ...editRow, relation: e.target.value })}
                      className="h-7 w-full rounded border border-input bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary">
                      <option value="">선택</option>
                      {RELATION_PRESETS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input value={editRow.birth} onChange={(e) => setEditRow({ ...editRow, birth: e.target.value })}
                      className="h-7 text-xs" placeholder="예: 1960.01.01" />
                  </td>
                  <td className="px-2 py-1.5">
                    <select value={editRow.cohabit ?? ""}
                      onChange={(e) => setEditRow({ ...editRow, cohabit: e.target.value })}
                      className="h-7 w-full rounded border border-input bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary">
                      <option value="">선택</option>
                      {COHABIT_PRESETS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input value={editRow.occupation} onChange={(e) => setEditRow({ ...editRow, occupation: e.target.value })}
                      className="h-7 text-xs" placeholder="직업" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input value={editRow.phone} onChange={(e) => setEditRow({ ...editRow, phone: e.target.value })}
                      className="h-7 text-xs" placeholder="연락처" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input value={editRow.memo ?? ""} onChange={(e) => setEditRow({ ...editRow, memo: e.target.value })}
                      className="h-7 text-xs" placeholder="비고" />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1">
                      <button onClick={updateMember} disabled={busy}
                        className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground disabled:opacity-50">
                        <Check className="h-3 w-3" />
                      </button>
                      <button onClick={cancelEdit}
                        className="text-[10px] px-2 py-0.5 rounded border border-input text-muted-foreground hover:bg-accent">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={m.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 text-sm font-medium">{m.name || "—"}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">{m.relation || "—"}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">{m.birth || "—"}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">{m.cohabit || "—"}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">{m.occupation || "—"}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">{m.phone || "—"}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground max-w-[160px] truncate" title={m.memo || ""}>{m.memo || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <button onClick={() => startEdit(m)}
                        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => deleteMember(m.id)}
                        className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            )}

            {/* 새 항목 입력 행 */}
            {adding && (
              <tr className="border-b bg-accent/10">
                <td className="px-2 py-1.5">
                  <Input value={newRow.name} onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
                    className="h-7 text-xs" placeholder="성명 *" autoFocus />
                </td>
                <td className="px-2 py-1.5">
                  <select value={newRow.relation}
                    onChange={(e) => setNewRow({ ...newRow, relation: e.target.value })}
                    className="h-7 w-full rounded border border-input bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary">
                    <option value="">선택</option>
                    {RELATION_PRESETS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <Input value={newRow.birth} onChange={(e) => setNewRow({ ...newRow, birth: e.target.value })}
                    className="h-7 text-xs" placeholder="예: 1960.01.01" />
                </td>
                <td className="px-2 py-1.5">
                  <select value={newRow.cohabit ?? ""}
                    onChange={(e) => setNewRow({ ...newRow, cohabit: e.target.value })}
                    className="h-7 w-full rounded border border-input bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary">
                    <option value="">선택</option>
                    {COHABIT_PRESETS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <Input value={newRow.occupation} onChange={(e) => setNewRow({ ...newRow, occupation: e.target.value })}
                    className="h-7 text-xs" placeholder="직업" />
                </td>
                <td className="px-2 py-1.5">
                  <Input value={newRow.phone} onChange={(e) => setNewRow({ ...newRow, phone: e.target.value })}
                    className="h-7 text-xs" placeholder="연락처" />
                </td>
                <td className="px-2 py-1.5">
                  <Input value={newRow.memo ?? ""} onChange={(e) => setNewRow({ ...newRow, memo: e.target.value })}
                    className="h-7 text-xs" placeholder="비고" />
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex gap-1">
                    <button onClick={addMember} disabled={busy}
                      className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground disabled:opacity-50">
                      <Check className="h-3 w-3" />
                    </button>
                    <button onClick={() => { setAdding(false); setNewRow(EMPTY); }}
                      className="text-[10px] px-2 py-0.5 rounded border border-input text-muted-foreground hover:bg-accent">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
