# 뒤집힌 바다 온라인

땅이 180도 뒤집힌 지구에서 호연이 교역·탐험·해전을 펼치는 항해 무역 게임의 온라인판입니다.

## 온라인에서 함께 쓰는 것
- 선장 이름 + 숫자 비밀번호로 로그인, 항해 1·2·3 저장이 서버에 보관됨 (PC·휴대폰 이어하기)
- 시세: 누가 팔고 사면 모두의 값이 함께 움직임 (실제 20초마다 0.9배로 회복)
- 항구 발전: 모든 선장의 투자와 교역이 한 항구에 쌓임
- 지도에 다른 선장의 배, 대화, 최초 발견자, 순위표
- 시간 배율(×1~×16)은 각자 자유

## 파일
- `server.js` 서버 (부품 없이 Node.js 기본 기능 + 직접 만든 웹소켓 `ws-lite.js`)
- `store.js` 저장소: `DATABASE_URL`이 있으면 PostgreSQL, 없으면 `data/` 폴더의 파일
- `public/index.html` 게임 화면 (한 파일)
- `render.yaml` Render 설정

## Render에 올리기
1. Render에서 New → Web Service → 이 저장소 선택
2. Runtime: Node, Build Command: `npm install`, Start Command: `node server.js`, Instance Type: Free
3. Environment에 `DATABASE_URL` = Neon 등 PostgreSQL 연결 주소 (없으면 서버를 다시 시작할 때 저장이 사라짐)
4. Environment에 `ADMIN_KEY` = 선생님용 관리자 비밀번호 (6자 이상). `/admin` 주소에서 학생 비밀번호 초기화·선장 삭제를 할 수 있습니다.
4. 배포가 끝나면 나오는 `https://….onrender.com` 주소로 접속

## 주의
- Render 무료 서버는 15분 동안 접속이 없으면 잠들고, 다음 접속 때 1분쯤 걸려 깨어납니다.
- 상태 확인: `/healthz` 주소에서 `store`가 `pg`, `storeOk`가 `true`면 데이터베이스가 연결된 것입니다.

지도 바탕: 이퀄 어스(Equal Earth) 도법 · 지도 제공: Equal Earth Map Share·VANK · 원본: equalearth.one
