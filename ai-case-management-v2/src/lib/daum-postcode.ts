// 다음(카카오) 우편번호 서비스 — 도로명/지번(구주소) 주소 검색 팝업.
// 공식 주소 DB에서 검색해 표준 주소를 돌려주므로, 네이버 지오코딩 정확도가 올라간다.
// 무료·키 불필요. 클릭 시에만 스크립트를 로드한다.

const SRC = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";

type PostcodeData = {
  roadAddress: string;
  jibunAddress: string;
  zonecode: string;
  buildingName?: string;
};
type DaumPostcode = {
  Postcode: new (opts: { oncomplete: (data: PostcodeData) => void }) => { open: () => void };
};
type DaumWindow = Window & { daum?: DaumPostcode };

export type AddressResult = {
  road: string; // 도로명 주소
  jibun: string; // 지번(구주소)
  zonecode: string; // 우편번호
  building: string; // 건물명(있으면)
};

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("브라우저에서만 사용할 수 있어요."));
  const w = window as DaumWindow;
  if (w.daum?.Postcode) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error("주소 검색 서비스를 불러오지 못했어요. 네트워크를 확인해 주세요."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** 주소 검색 팝업을 열고, 선택 결과를 onSelect로 전달한다. */
export async function openAddressSearch(onSelect: (r: AddressResult) => void): Promise<void> {
  await loadScript();
  const w = window as DaumWindow;
  if (!w.daum?.Postcode) throw new Error("주소 검색 서비스를 사용할 수 없어요.");
  new w.daum.Postcode({
    oncomplete: (data) => {
      onSelect({
        road: data.roadAddress || "",
        jibun: data.jibunAddress || "",
        zonecode: data.zonecode || "",
        building: data.buildingName || "",
      });
    },
  }).open();
}
