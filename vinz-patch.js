/* ====================================================================
   VINZPROSTORE — patch script untuk index.html
   Cara pakai: simpan file ini di root repo, lalu di index.html tambahkan
   1 baris SEBELUM </body>:
     <script type="module" src="./vinz-patch.js"></script>

   Fitur:
   1. Saat user login → device auto-fingerprint, didaftarkan ke RPC
      register_device_auto (status pending). Tidak ada input nama device.
   2. Panel admin "Devices" otomatis pakai list_devices baru + tombol
      ENROLL/HAPUS. Tombol APPROVE tetap, BLOKIR jadi HAPUS.
   3. Single-session: setelah login, claim_session dipanggil → device lain
      yang login pakai email yang sama akan auto-logout via realtime.
   4. Setelah device di-approve owner, user dapat tombol "ENROLL WAJAH"
      (modal MediaPipe liveness). Descriptor disimpan ke devices.face_descriptor.
   ==================================================================== */

import { FilesetResolver, FaceLandmarker }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

(async () => {
  const sb = window._sb;
  if (!sb) { console.warn('[vinz-patch] _sb not ready'); return; }

  // ---------- Device fingerprint ----------
  async function getFingerprint(){
    try{
      const m = await import('https://openfpcdn.io/fingerprintjs/v4');
      const fp = await m.load();
      const r = await fp.get();
      return r.visitorId;
    }catch(e){ return navigator.userAgent + '|' + screen.width+'x'+screen.height; }
  }
  function getDeviceId(){
    let id = localStorage.getItem('vp_dev_id');
    if (!id){ id = crypto.randomUUID(); localStorage.setItem('vp_dev_id', id); }
    return id;
  }
  const DEVICE_ID = getDeviceId();
  let FP = await getFingerprint();
  window.__vinzDevice = { id: DEVICE_ID, fp: FP };

  // ---------- 1. Daftar device tiap kali user login ----------
  async function registerCurrentDevice(){
    const u = JSON.parse(localStorage.getItem('vp_user')||'null');
    if (!u || !u.email) return;
    try{
      await sb.rpc('register_device_auto', {
        p_device_id: DEVICE_ID, p_fingerprint: FP,
        p_ua: navigator.userAgent, p_email: u.email
      });
    }catch(e){ console.warn('register_device_auto', e); }
    // claim session token (kick device lain)
    try{
      const { data } = await sb.rpc('claim_session', { p_email: u.email, p_device_id: DEVICE_ID });
      localStorage.setItem('vp_session_token', data);
      subscribeSession(u.email);
    }catch(e){ console.warn('claim_session', e); }
  }

  // ---------- 2. Single-session realtime ----------
  let sessionChan = null;
  function subscribeSession(email){
    if (sessionChan) { try{ sb.removeChannel(sessionChan); }catch(_){} }
    sessionChan = sb.channel('sess_'+email)
      .on('postgres_changes',
        { event:'*', schema:'public', table:'active_sessions', filter:`email=eq.${email}` },
        payload => {
          const myTok = localStorage.getItem('vp_session_token');
          const newTok = payload.new && payload.new.session_token;
          if (newTok && newTok !== myTok){
            alert('⚠️ Akun ini login di device lain. Anda akan di-logout.');
            localStorage.removeItem('vp_user');
            localStorage.removeItem('vp_session_token');
            location.reload();
          }
        }).subscribe();
  }

  // Kalau sudah login saat halaman dibuka
  if (localStorage.getItem('vp_user')) registerCurrentDevice();

  // Patch doLogin: panggil registerCurrentDevice setelah sukses
  const _origDoLogin = window.doLogin;
  if (typeof _origDoLogin === 'function'){
    window.doLogin = async function(){
      await _origDoLogin.apply(this, arguments);
      setTimeout(registerCurrentDevice, 500);
    };
  }

  // ---------- 3. Panel device override ----------
  // Replace fungsi loadDevices supaya pakai data baru + face status
  window.loadDevices = async function(){
    const box = document.getElementById('devList');
    if (!box) return;
    const pw = sessionStorage.getItem('vp_admin_pw') || prompt('Password admin:');
    if (!pw) return;
    sessionStorage.setItem('vp_admin_pw', pw);
    box.innerHTML = 'Memuat…';
    try{
      const { data, error } = await sb.rpc('list_devices', { p_pass: pw });
      if (error) throw error;
      if (!data || !data.length){ box.innerHTML = '<div style="color:var(--muted)">Belum ada device.</div>'; return; }
      box.innerHTML = data.map(d => {
        const col = d.status==='approved' ? '#00ff88'
                  : d.status==='blocked'  ? '#ff4455' : '#ffd700';
        const faceTxt = d.face_enrolled ? '✅ Wajah ter-enroll' : '⚠️ Belum enroll wajah';
        return `
          <div style="background:#0a1a35;border:1px solid rgba(26,111,255,.25);border-radius:10px;padding:10px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
              <div style="flex:1;min-width:0;">
                <div style="color:#fff;font-weight:700;font-size:13px;">${d.name||'-'}</div>
                <div style="color:#6a8cb5;font-size:11px;word-break:break-all;">${d.phone||'-'}</div>
                <div style="color:#6a8cb5;font-size:10px;">${new Date(d.created_at).toLocaleString('id-ID')}</div>
                <div style="color:${col};font-size:10px;font-weight:900;letter-spacing:1px;text-transform:uppercase;margin-top:3px;">${d.status} · ${faceTxt}</div>
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;max-width:140px;">
                <button onclick="setDevice('${d.device_id}','approved')" style="background:#00ff88;color:#000;border:none;border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;font-weight:900;">APPROVE</button>
                <button onclick="setDevice('${d.device_id}','blocked')" style="background:#ff4455;color:#fff;border:none;border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;font-weight:900;">HAPUS</button>
                <button onclick="setDevice('${d.device_id}','pending')" style="background:#0f2244;color:#6a8cb5;border:1px solid rgba(26,111,255,.25);border-radius:5px;padding:4px 8px;font-size:10px;cursor:pointer;">RESET</button>
              </div>
            </div>
          </div>`;
      }).join('');
    }catch(e){
      box.innerHTML = '<div style="color:#ff4455">Gagal: '+(e.message||e)+'</div>';
    }
  };

  // ---------- 4. Face enroll modal ----------
  function ensureFaceModal(){
    if (document.getElementById('vpFaceOv')) return;
    const ov = document.createElement('div');
    ov.id='vpFaceOv';
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:9999;padding:20px';
    ov.innerHTML = `
      <div style="background:#0d1f3c;border:1px solid #1a6fff;border-radius:16px;padding:20px;max-width:420px;width:100%;color:#e0eaff;text-align:center;font-family:'Rajdhani',sans-serif;">
        <h3 style="font-family:'Orbitron',sans-serif;letter-spacing:2px;margin-bottom:10px;font-size:16px;">ENROLL WAJAH</h3>
        <p style="color:#6a8cb5;font-size:12px;line-height:1.5;margin-bottom:12px">Ikuti instruksi liveness. Wajah dipakai untuk verifikasi saat ambil key.</p>
        <video id="vpFaceVid" autoplay playsinline muted style="width:100%;border-radius:12px;background:#000;transform:scaleX(-1);max-height:300px"></video>
        <div id="vpChallenge" style="font-family:'Orbitron',sans-serif;letter-spacing:2px;color:#00d4ff;font-size:13px;padding:8px;border-radius:8px;background:rgba(55,225,255,.08);margin:10px 0">Tunggu kamera…</div>
        <div id="vpFaceErr" style="color:#ff4455;font-size:12px;min-height:14px"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
          <button id="vpFaceCancel" style="padding:10px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;border-radius:8px;font-weight:700;cursor:pointer">BATAL</button>
          <button id="vpFaceStart" style="padding:10px;border:0;background:linear-gradient(90deg,#00d4ff,#1a6fff);color:#001;border-radius:8px;font-weight:900;cursor:pointer">MULAI</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  }

  let faceLandmarker = null;
  async function initFace(){
    if (faceLandmarker) return;
    const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions:{ modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" },
      outputFaceBlendshapes:true, runningMode:"VIDEO", numFaces:1
    });
  }
  function shuffle(a){ a=[...a]; for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]];} return a; }
  async function waitForChallenge(type, vid, timeoutMs){
    const start = performance.now(); let baseline=null; let blinkLow=false;
    while (performance.now()-start < timeoutMs){
      const res = faceLandmarker.detectForVideo(vid, performance.now());
      if (res.faceLandmarks && res.faceLandmarks[0]){
        const lm = res.faceLandmarks[0];
        const bs = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
        if (type==='blink' && bs){
          const L = bs.find(x=>x.categoryName==='eyeBlinkLeft')?.score||0;
          const R = bs.find(x=>x.categoryName==='eyeBlinkRight')?.score||0;
          if ((L+R)/2 > 0.5) blinkLow = true;
          if (blinkLow && (L+R)/2 < 0.15) return true;
        }
        if (type==='left' || type==='right'){
          const nose = lm[1];
          if (baseline===null) baseline = nose.x;
          const dx = nose.x - baseline;
          if (type==='left' && dx > 0.06) return true;
          if (type==='right' && dx < -0.06) return true;
        }
      }
      await new Promise(r=>setTimeout(r,80));
    }
    return false;
  }
  async function captureDescriptor(vid){
    const SAMPLE_IDX=[]; const step=Math.floor(468/64);
    for (let i=0;i<468;i+=step) SAMPLE_IDX.push(i);
    const frames=[];
    for (let i=0;i<5;i++){
      const res = faceLandmarker.detectForVideo(vid, performance.now()+i);
      if (res.faceLandmarks && res.faceLandmarks[0]){
        const lm=res.faceLandmarks[0]; const cx=lm[1].x, cy=lm[1].y; const arr=[];
        for (const idx of SAMPLE_IDX) arr.push(+(lm[idx].x-cx).toFixed(4), +(lm[idx].y-cy).toFixed(4));
        frames.push(arr);
      }
      await new Promise(r=>setTimeout(r,100));
    }
    if (!frames.length) throw new Error('Wajah tidak terdeteksi');
    const len=frames[0].length; const avg=new Array(len).fill(0);
    frames.forEach(f => f.forEach((v,i)=>avg[i]+=v));
    return avg.map(v => +(v/frames.length).toFixed(5));
  }

  window.vinzEnrollFace = async function(){
    ensureFaceModal();
    await initFace();
    const ov=document.getElementById('vpFaceOv'); ov.style.display='flex';
    const vid=document.getElementById('vpFaceVid');
    const ch=document.getElementById('vpChallenge');
    const err=document.getElementById('vpFaceErr');
    err.textContent='';
    let stream;
    try{
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:480},audio:false});
      vid.srcObject = stream; await vid.play();
    }catch(e){ err.textContent='Kamera gagal: '+e.message; return; }
    document.getElementById('vpFaceCancel').onclick = () => {
      stream.getTracks().forEach(t=>t.stop()); ov.style.display='none';
    };
    document.getElementById('vpFaceStart').onclick = async () => {
      document.getElementById('vpFaceStart').disabled=true;
      try{
        const challenges = shuffle(['blink','left','right']).slice(0,2);
        for (const c of challenges){
          ch.textContent = c==='blink' ? '👁️ KEDIPKAN MATA' : c==='left' ? '👈 NOLEH KIRI' : '👉 NOLEH KANAN';
          const ok = await waitForChallenge(c, vid, 8000);
          if (!ok){ err.textContent='Liveness gagal: '+c; document.getElementById('vpFaceStart').disabled=false; return; }
        }
        ch.textContent='✅ MENYIMPAN…';
        const desc = await captureDescriptor(vid);
        const { error } = await sb.rpc('enroll_face', {
          p_device_id: DEVICE_ID, p_fingerprint: FP, p_descriptor: desc
        });
        if (error) throw error;
        stream.getTracks().forEach(t=>t.stop()); ov.style.display='none';
        alert('✅ Wajah berhasil di-enroll. Sekarang bisa pakai ambil-key.html');
      }catch(e){ err.textContent=e.message||String(e); document.getElementById('vpFaceStart').disabled=false; }
    };
  };

  // ---------- 5. Banner "Enroll wajah sekarang" kalau device approved tapi belum enroll ----------
  async function checkSelfDeviceStatus(){
    try{
      const pw = sessionStorage.getItem('vp_admin_pw');
      if (!pw) return; // banner hanya untuk admin/owner; reseller cek lewat panel
      const { data } = await sb.rpc('list_devices', { p_pass: pw });
      if (!data) return;
      const mine = data.find(d => d.device_id === DEVICE_ID);
      if (mine && mine.status==='approved' && !mine.face_enrolled){
        showEnrollBanner();
      }
    }catch(e){}
  }
  function showEnrollBanner(){
    if (document.getElementById('vpEnrollBanner')) return;
    const b = document.createElement('div');
    b.id='vpEnrollBanner';
    b.style.cssText='position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:#0d1f3c;border:1px solid #00d4ff;border-radius:12px;padding:10px 14px;color:#e0eaff;font-family:Rajdhani,sans-serif;font-size:13px;z-index:9998;display:flex;gap:10px;align-items:center;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    b.innerHTML = `Device approved · <b>Enroll wajah</b> dulu →
      <button id="vpEnrollGo" style="background:linear-gradient(90deg,#00d4ff,#1a6fff);border:0;color:#001;font-weight:900;padding:6px 12px;border-radius:7px;cursor:pointer">ENROLL</button>
      <button id="vpEnrollX" style="background:transparent;border:0;color:#6a8cb5;cursor:pointer;font-size:18px">×</button>`;
    document.body.appendChild(b);
    document.getElementById('vpEnrollGo').onclick = () => { b.remove(); window.vinzEnrollFace(); };
    document.getElementById('vpEnrollX').onclick = () => b.remove();
  }
  setTimeout(checkSelfDeviceStatus, 2000);

  console.log('[vinz-patch] loaded · device', DEVICE_ID.slice(0,8), 'fp', FP.slice(0,8));
})();
