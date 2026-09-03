const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';
const CANVAS_MARGIN = 900;
const MIN_NOTCH_SIZE = 800;
const catalog = {
    structure: [
        ['bathroom', '욕실', '🛁', 1600, 2000],
        ['sinkStraight', '싱크대 · 일자형', '▰', 2400, 650],
        ['sinkL', '싱크대 · ㄱ자형', '◩', 2200, 1800],
        ['sinkU', '싱크대 · ㄷ자형', '⊔', 2400, 1900],
        ['island', '아일랜드 식탁', '▤', 1600, 800],
        ['entrance', '현관', '🚪', 1200, 1000],
        ['window', '창문', '▭', 900, 120],
        ['middleDoor', '중문', '⇆', 1000, 120],
        ['closet', '붙박이장', '▥', 600, 1800],
        ['pillar', '기둥/벽', '▣', 300, 300]
    ],
    furniture: [['bed', '침대', '🛏️', 1500, 2000], ['desk', '책상', '🪑', 1200, 600], ['chair', '의자', '🪑', 500, 500], ['sofa', '소파', '🛋️', 1800, 850], ['storage', '수납장', '🗄️', 800, 400], ['table', '식탁', '▤', 1200, 800], ['tv', 'TV장', '📺', 1400, 400], ['fridge', '냉장고', '▥', 900, 700]]
};
// 상품 데이터 접속 모드
// true  : 로컬 Node.js API -> SQLite
// false : Cloudflare Worker API -> D1
// 이 값 하나로 플래너와 admin 페이지의 DB 모드를 함께 전환합니다.
const USE_LOCAL_DB = false;

// 한 번 불러온 카테고리 상품은 페이지가 열려 있는 동안 메모리에 보관한다.
const productCache = new Map();
const productLoadPromises = new Map();


// ------------------------------------------------------------
// 방문 / 상품 클릭 통계
// USE_LOCAL_DB=true  -> 로컬 Node.js API -> SQLite
// USE_LOCAL_DB=false -> Cloudflare Worker API -> D1
// ------------------------------------------------------------
const VISIT_STORAGE_KEY = 'officetel_planner_last_visit_date';

function getKoreaDateKey() {
    // 한국은 DST가 없으므로 UTC+9를 적용해 YYYY-MM-DD를 만든다.
    return new Date(Date.now() + 9 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
}

function recordPageVisit() {
    const statsApi = USE_LOCAL_DB ? localProductApi : d1ProductApi;
    if (!statsApi || typeof statsApi.recordVisit !== 'function') return;

    const today = getKoreaDateKey();
    let isUnique = true;

    try {
        const lastVisitDate = localStorage.getItem(VISIT_STORAGE_KEY);
        isUnique = lastVisitDate !== today;

        if (isUnique) {
            localStorage.setItem(VISIT_STORAGE_KEY, today);
        }
    } catch (error) {
        // localStorage 사용이 제한된 환경에서는 방문 자체는 기록한다.
        console.warn('방문자 중복 확인 저장소를 사용할 수 없습니다.', error);
    }

    statsApi.recordVisit(isUnique)
        .catch(error => console.warn('방문 통계 기록 실패:', error));
}

function recordProductClick(product) {
    const statsApi = USE_LOCAL_DB ? localProductApi : d1ProductApi;
    if (!statsApi || typeof statsApi.recordProductClick !== 'function') return;

    const productId = Number(product?.id);
    if (!Number.isInteger(productId) || productId <= 0) return;

    statsApi.recordProductClick(productId)
        .catch(error => console.warn('상품 클릭 통계 기록 실패:', error));
}

let state = { room: { w: 6500, h: 4200, type: 'rectangle', lshapeCorner: 'tr' }, items: [], selectedId: null, zoom: 0.8, history: [], future: [] };
let drag = null;
let resizeDrag = null;
let contextItemId = null;
let roomContextOpen = false;
let notchDrag = null;
let roomResizeDrag = null;


const roomTemplates = {
    rectangle: { name: '직사각형 원룸', w: 6500, h: 4200 },
    lshape:    { name: 'ㄱ자형 원룸',     w: 6500, h: 5200 },
    oneHalf:   { name: '1.5룸',           w: 6500, h: 5200 },
    twoRoom:   { name: '투룸',            w: 7200, h: 6000 },
    blank:     { name: '빈 도면',         w: 6500, h: 4200 }
};

let selectedTemplate = 'rectangle';

function templateName(type) {
    return roomTemplates[type]?.name || '직사각형 원룸';
}

function wallItem(x, y, w, h, name = '내부벽') {
    return {
        id: uid(), type: 'wall', name, kind: 'wall',
        x, y, w, h, rot: 0, color: '#333'
    };
}

function structureItem(type, name, x, y, w, h, color) {
    return { id: uid(), type, name, kind: 'structure', x, y, w, h, rot: 0, color };
}

function openTemplateModal() {
    selectedTemplate = state.room.type || 'rectangle';
    $$('.template-card').forEach(card => card.classList.toggle('active', card.dataset.template === selectedTemplate));
    $('#templateW').value = state.room.w || roomTemplates[selectedTemplate].w;
    $('#templateH').value = state.room.h || roomTemplates[selectedTemplate].h;
    $('#templateModal').classList.remove('hidden');
}

function closeTemplateModal() {
    $('#templateModal').classList.add('hidden');
}

function createFromTemplate(type, width, height) {
    const w = Math.max(1500, Number(width) || roomTemplates[type]?.w || 6500);
    const h = Math.max(1500, Number(height) || roomTemplates[type]?.h || 4200);

    pushHistory();
    state.room = { w, h, type, lshapeCorner: 'tr' };
    if (type === 'lshape') {
        state.room.notchX = Math.round(w * 0.66 / 10) * 10;
        state.room.notchY = Math.round(h * 0.30 / 10) * 10;
    }
    state.items = [];
    state.selectedId = null;

    // 템플릿은 '완성된 집'이 아니라 수정 가능한 시작점이다.
    if (type === 'rectangle') {
        state.items.push(
            structureItem('entrance', '현관', Math.round(w * 0.40), Math.round(h * 0.78), Math.round(w * 0.20), Math.round(h * 0.22), '#e5ded2')
        );
    }

    if (type === 'lshape') {
        // 외곽은 L자형으로 렌더링되고, 현관만 시작점으로 제공
        state.items.push(
            structureItem('entrance', '현관', Math.round(w * 0.12), Math.round(h * 0.84), Math.round(w * 0.24), Math.round(h * 0.16), '#e5ded2')
        );
    }

    if (type === 'oneHalf') {
        const wallX = Math.round(w * 0.46);
        state.items.push(
            wallItem(wallX, 0, 120, Math.round(h * 0.40), '침실 분리벽'),
            structureItem('entrance', '현관', Math.round(w * 0.40), Math.round(h * 0.78), Math.round(w * 0.20), Math.round(h * 0.22), '#e5ded2')
        );
    }

    if (type === 'twoRoom') {
        const wallX = Math.round(w * 0.50);
        const doorGapStart = Math.round(h * 0.34);
        const doorGapEnd = Math.round(h * 0.48);
        state.items.push(
            wallItem(wallX, 0, 120, doorGapStart, '방 분리벽'),
            wallItem(wallX, doorGapEnd, 120, Math.round(h * 0.30), '방 분리벽'),
            structureItem('entrance', '현관', Math.round(w * 0.40), Math.round(h * 0.78), Math.round(w * 0.20), Math.round(h * 0.22), '#e5ded2')
        );
    }

    // 현관은 항상 외벽에 붙여 둔다.
    state.items.filter(i => i.type === 'entrance').forEach(i => snapEntranceToWall(i));
    state.items.filter(isWallFixture).forEach(i => snapWallFixture(i, i.wallKey));

    // blank는 아무 구조물도 넣지 않는다.
    syncInputs();
    render();
    closeTemplateModal();
}

function roomFloorPath(margin) {
    const w = state.room.w;
    const h = state.room.h;

    if (state.room.type === 'lshape') {
        const nx = margin + getNotchX();
        const ny = margin + getNotchY();
        const left = margin;
        const top = margin;
        const right = margin + w;
        const bottom = margin + h;
        const corner = state.room.lshapeCorner || 'tr';

        if (corner === 'br') return `M ${left} ${top} H ${right} V ${ny} H ${nx} V ${bottom} H ${left} Z`;
        if (corner === 'bl') return `M ${left} ${top} H ${right} V ${bottom} H ${nx} V ${ny} H ${left} Z`;
        if (corner === 'tl') return `M ${nx} ${top} H ${right} V ${bottom} H ${left} V ${ny} H ${nx} Z`;
        return `M ${left} ${top} H ${nx} V ${ny} H ${right} V ${bottom} H ${left} Z`;
    }

    return `M ${margin} ${margin} H ${margin + w} V ${margin + h} H ${margin} Z`;
}

function fitsInRoom(it, x, y) {
    const bounds = getRenderedBounds(it, x, y);

    if (
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.w > state.room.w ||
        bounds.y + bounds.h > state.room.h
    ) return false;

    if (state.room.type !== 'lshape') return true;

    const notchX = getNotchX();
    const notchY = getNotchY();
    const corner = state.room.lshapeCorner || 'tr';
    let intersectsCutout = false;
    if (corner === 'tr') intersectsCutout = bounds.x + bounds.w > notchX && bounds.y < notchY;
    if (corner === 'br') intersectsCutout = bounds.x + bounds.w > notchX && bounds.y + bounds.h > notchY;
    if (corner === 'bl') intersectsCutout = bounds.x < notchX && bounds.y + bounds.h > notchY;
    if (corner === 'tl') intersectsCutout = bounds.x < notchX && bounds.y < notchY;
    return !intersectsCutout;
}

function getNotchX() {
    const fallback = Math.round(state.room.w * 0.66 / 10) * 10;
    return clamp(Number(state.room.notchX) || fallback, MIN_NOTCH_SIZE, Math.max(MIN_NOTCH_SIZE, state.room.w - MIN_NOTCH_SIZE));
}

function getNotchY() {
    const fallback = Math.round(state.room.h * 0.30 / 10) * 10;
    return clamp(Number(state.room.notchY) || fallback, MIN_NOTCH_SIZE, Math.max(MIN_NOTCH_SIZE, state.room.h - MIN_NOTCH_SIZE));
}

function normalizeLShapeRoom() {
    if (state.room.type !== 'lshape') return;
    state.room.notchX = Math.round(getNotchX() / 10) * 10;
    state.room.notchY = Math.round(getNotchY() / 10) * 10;
}

function roomBoundarySegments() {
    const w = state.room.w;
    const h = state.room.h;
    if (state.room.type !== 'lshape') {
        return [
            { key:'top', side:'top', orientation:'h', x1:0, y1:0, x2:w, y2:0 },
            { key:'right', side:'right', orientation:'v', x1:w, y1:0, x2:w, y2:h },
            { key:'bottom', side:'bottom', orientation:'h', x1:0, y1:h, x2:w, y2:h },
            { key:'left', side:'left', orientation:'v', x1:0, y1:0, x2:0, y2:h }
        ];
    }

    const nx = getNotchX();
    const ny = getNotchY();
    const corner = state.room.lshapeCorner || 'tr';

    if (corner === 'br') return [
        { key:'top', side:'top', orientation:'h', x1:0, y1:0, x2:w, y2:0 },
        { key:'right', side:'right', orientation:'v', x1:w, y1:0, x2:w, y2:ny },
        { key:'notchHorizontal', side:'bottom', orientation:'h', x1:nx, y1:ny, x2:w, y2:ny },
        { key:'notchVertical', side:'right', orientation:'v', x1:nx, y1:ny, x2:nx, y2:h },
        { key:'bottom', side:'bottom', orientation:'h', x1:0, y1:h, x2:nx, y2:h },
        { key:'left', side:'left', orientation:'v', x1:0, y1:0, x2:0, y2:h }
    ];
    if (corner === 'bl') return [
        { key:'top', side:'top', orientation:'h', x1:0, y1:0, x2:w, y2:0 },
        { key:'right', side:'right', orientation:'v', x1:w, y1:0, x2:w, y2:h },
        { key:'bottom', side:'bottom', orientation:'h', x1:nx, y1:h, x2:w, y2:h },
        { key:'notchVertical', side:'left', orientation:'v', x1:nx, y1:ny, x2:nx, y2:h },
        { key:'notchHorizontal', side:'bottom', orientation:'h', x1:0, y1:ny, x2:nx, y2:ny },
        { key:'left', side:'left', orientation:'v', x1:0, y1:0, x2:0, y2:ny }
    ];
    if (corner === 'tl') return [
        { key:'top', side:'top', orientation:'h', x1:nx, y1:0, x2:w, y2:0 },
        { key:'right', side:'right', orientation:'v', x1:w, y1:0, x2:w, y2:h },
        { key:'bottom', side:'bottom', orientation:'h', x1:0, y1:h, x2:w, y2:h },
        { key:'left', side:'left', orientation:'v', x1:0, y1:ny, x2:0, y2:h },
        { key:'notchHorizontal', side:'top', orientation:'h', x1:0, y1:ny, x2:nx, y2:ny },
        { key:'notchVertical', side:'left', orientation:'v', x1:nx, y1:0, x2:nx, y2:ny }
    ];
    return [
        { key:'top', side:'top', orientation:'h', x1:0, y1:0, x2:nx, y2:0 },
        { key:'notchVertical', side:'right', orientation:'v', x1:nx, y1:0, x2:nx, y2:ny },
        { key:'notchHorizontal', side:'top', orientation:'h', x1:nx, y1:ny, x2:w, y2:ny },
        { key:'right', side:'right', orientation:'v', x1:w, y1:ny, x2:w, y2:h },
        { key:'bottom', side:'bottom', orientation:'h', x1:0, y1:h, x2:w, y2:h },
        { key:'left', side:'left', orientation:'v', x1:0, y1:0, x2:0, y2:h }
    ];
}

function distanceToSegment(px, py, seg) {
    const minX = Math.min(seg.x1, seg.x2), maxX = Math.max(seg.x1, seg.x2);
    const minY = Math.min(seg.y1, seg.y2), maxY = Math.max(seg.y1, seg.y2);
    const qx = clamp(px, minX, maxX);
    const qy = clamp(py, minY, maxY);
    return Math.hypot(px - qx, py - qy);
}

function entranceFitsSegment(it, seg) {
    const len = seg.orientation === 'h' ? Math.abs(seg.x2 - seg.x1) : Math.abs(seg.y2 - seg.y1);
    return seg.orientation === 'h' ? it.w <= len : it.h <= len;
}

function placeEntranceOnSegment(it, seg) {
    it.wallKey = seg.key;
    it.wallSide = seg.side;
    it.rot = 0;

    if (seg.orientation === 'h') {
        const minX = Math.min(seg.x1, seg.x2);
        const maxX = Math.max(seg.x1, seg.x2) - it.w;
        it.x = clamp(it.x, minX, Math.max(minX, maxX));
        if (seg.side === 'top') it.y = seg.y1;
        else it.y = seg.y1 - it.h;
    } else {
        const minY = Math.min(seg.y1, seg.y2);
        const maxY = Math.max(seg.y1, seg.y2) - it.h;
        it.y = clamp(it.y, minY, Math.max(minY, maxY));
        if (seg.side === 'right') it.x = seg.x1 - it.w;
        else it.x = seg.x1;
    }

    it.x = Math.round(it.x / 10) * 10;
    it.y = Math.round(it.y / 10) * 10;
}

function seed() {
    state.room = { w: 6500, h: 4200, type: 'rectangle', lshapeCorner: 'tr' };
    state.items = [
        { id: uid(), type: 'entrance', name: '현관', kind: 'structure', x: 2600, y: 3300, w: 1300, h: 900, rot: 0, color: '#e5ded2' }
    ];
    state.items.filter(i => i.type === 'entrance').forEach(i => snapEntranceToWall(i));
    state.items.filter(isWallFixture).forEach(i => snapWallFixture(i, i.wallKey));
    state.selectedId = null;
}
function uid() { return Math.random().toString(36).slice(2, 9) }
function pushHistory() { state.history.push(JSON.stringify({ room: state.room, items: state.items, selectedId: state.selectedId })); if (state.history.length > 50) state.history.shift(); state.future = [] }
function restore(s) { const o = JSON.parse(s); state.room = { type: 'rectangle', lshapeCorner: 'tr', ...o.room }; normalizeLShapeRoom(); state.items = o.items; state.items.filter(i => i.type === 'entrance').forEach(i => snapEntranceToWall(i)); state.items.filter(isWallFixture).forEach(i => snapWallFixture(i)); state.selectedId = o.selectedId; syncInputs(); render() }
function buildTools() { catalog.structure.forEach(x => $('#structureTools').appendChild(toolEl(x, 'structure'))); catalog.furniture.forEach(x => $('#furnitureTools').appendChild(toolEl(x, 'furniture'))) }
function toolEl(x, kind) { const d = document.createElement('div'); d.className = 'tool-item'; d.innerHTML = `<span class="tool-icon">${x[2]}</span><span>${x[1]}</span>`; d.onclick = () => addItem(x, kind); return d }
function addItem(x, kind) { pushHistory(); const [type, name, icon, w, h] = x; const item = { id: uid(), type, name, kind, x: Math.max(0, (state.room.w - w) / 2), y: Math.max(0, (state.room.h - h) / 2), w, h, rot: 0, color: kind === 'furniture' ? '#eadbc8' : '#d7dde6' }; if (item.type === 'entrance') snapEntranceToWall(item); if (isWallFixture(item)) snapWallFixture(item); state.items.push(item); state.selectedId = item.id; render() }
function syncRoomDimensionInputs() {
    if ($('#roomW')) $('#roomW').value = Math.round(state.room.w);
    if ($('#roomH')) $('#roomH').value = Math.round(state.room.h);
    if ($('#detailRoomW')) $('#detailRoomW').value = Math.round(state.room.w);
    if ($('#detailRoomH')) $('#detailRoomH').value = Math.round(state.room.h);

    const isL = state.room.type === 'lshape';
    const controls = $('#lshapeControls');
    if (controls) controls.classList.toggle('hidden', !isL);
    const detailControls = $('#detailLshapeControls');
    if (detailControls) detailControls.classList.toggle('hidden', !isL);

    if (isL) {
        const nx = Math.round(getNotchX());
        const ny = Math.round(getNotchY());
        if ($('#notchX')) $('#notchX').value = nx;
        if ($('#notchY')) $('#notchY').value = ny;
        if ($('#detailNotchX')) $('#detailNotchX').value = nx;
        if ($('#detailNotchY')) $('#detailNotchY').value = ny;
    }
}

function syncInputs() {
    syncRoomDimensionInputs();
    const badge = $('#roomTypeLabel');
    if (badge) badge.textContent = templateName(state.room.type);
}

function render() {
    renderSvg();
    renderProperties();
    renderPlaced();
    renderProductTabs();
    renderProducts(activeProductCat());
    $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
    $('#canvasViewport').style.transform = `scale(${state.zoom})`;
    const badge = $('#roomTypeLabel');
    if (badge) badge.textContent = templateName(state.room.type);
    syncRoomDimensionInputs();
}
function addSvg(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);

    Object.entries(attrs).forEach(([key, value]) => {
        el.setAttribute(key, value);
    });

    return el;
}


function drawDetailedFurniture(g, it, x, y, w, h) {
    const add = (tag, attrs = {}) => {
        const el = addSvg(tag, attrs);
        g.appendChild(el);
        return el;
    };
    const line = (x1,y1,x2,y2,stroke='#9b8a75',sw=7,opacity=1) => add('line',{x1,y1,x2,y2,stroke,'stroke-width':sw,opacity,'stroke-linecap':'round'});

    const shadowGroup = addSvg('g', { filter:'url(#furnitureShadow)' });
    g.appendChild(shadowGroup);
    const sgAdd = (tag, attrs={}) => { const el=addSvg(tag, attrs); shadowGroup.appendChild(el); return el; };

    if (it.type === 'bed') {
        sgAdd('rect',{x:x+8,y:y+8,width:w-16,height:h-16,rx:55,fill:'#8d745a',opacity:.95});
        add('rect',{x:x+38,y:y+42,width:w-76,height:h-78,rx:48,fill:'url(#linenGrad)',stroke:'#b8aa98','stroke-width':11});
        add('rect',{x:x+20,y:y+18,width:w-40,height:Math.max(95,h*.115),rx:28,fill:'#8d6546',stroke:'#674a36','stroke-width':9});
        const pw=(w-180)/2;
        [0,1].forEach(i=>{
            add('rect',{x:x+65+i*(pw+50),y:y+h*.15,width:pw,height:h*.18,rx:42,fill:'#fffdfa',stroke:'#d1c7b8','stroke-width':9,filter:'url(#softInner)'});
            line(x+82+i*(pw+50),y+h*.23,x+65+pw-18+i*(pw+50),y+h*.23,'#e2d9cc',5,.8);
        });
        add('path',{d:`M ${x+62} ${y+h*.39} Q ${x+w*.48} ${y+h*.34} ${x+w-62} ${y+h*.40} L ${x+w-62} ${y+h*.90} Q ${x+w*.50} ${y+h*.95} ${x+62} ${y+h*.89} Z`,fill:'#d9cfbf',stroke:'#b7aa98','stroke-width':8});
        [0.52,0.64,0.76].forEach(r=>line(x+95,y+h*r,x+w-95,y+h*(r+.02),'#c1b3a1',6,.55));
        return true;
    }

    if (it.type === 'desk') {
        sgAdd('rect',{x:x+12,y:y+12,width:w-24,height:h-24,rx:32,fill:'url(#woodFurniture)',stroke:'#6f4e35','stroke-width':12});
        [0.18,0.36,0.58,0.78].forEach(r=>line(x+35,y+h*r,x+w-35,y+h*(r-.025),'#815a3c',6,.28));
        add('rect',{x:x+w*.58,y:y+h*.10,width:w*.25,height:h*.31,rx:14,fill:'#272d33',stroke:'#11161b','stroke-width':9});
        add('rect',{x:x+w*.61,y:y+h*.135,width:w*.19,height:h*.22,rx:7,fill:'#7ba9c9'});
        add('line',{x1:x+w*.705,y1:y+h*.41,x2:x+w*.705,y2:y+h*.49,stroke:'#34383d','stroke-width':12});
        add('rect',{x:x+w*.56,y:y+h*.51,width:w*.34,height:h*.13,rx:10,fill:'#dedede',stroke:'#8a8a8a','stroke-width':6});
        add('ellipse',{cx:x+w*.30,cy:y+h*.37,rx:w*.07,ry:h*.13,fill:'#f0ede6',stroke:'#9a8e7d','stroke-width':6});
        add('circle',{cx:x+w*.30,cy:y+h*.34,r:Math.max(12,Math.min(w,h)*.025),fill:'#6b5847'});
        return true;
    }

    if (it.type === 'chair') {
        sgAdd('rect',{x:x+w*.15,y:y+h*.22,width:w*.70,height:h*.62,rx:w*.19,fill:'#746d65',stroke:'#45413d','stroke-width':11});
        add('rect',{x:x+w*.21,y:y+h*.07,width:w*.58,height:h*.28,rx:w*.14,fill:'#817970',stroke:'#504a45','stroke-width':10});
        add('rect',{x:x+w*.25,y:y+h*.30,width:w*.50,height:h*.42,rx:w*.15,fill:'#918980',stroke:'#5d5751','stroke-width':8});
        line(x+w*.16,y+h*.45,x+w*.04,y+h*.58,'#4b4743',11); line(x+w*.84,y+h*.45,x+w*.96,y+h*.58,'#4b4743',11);
        line(x+w*.34,y+h*.80,x+w*.22,y+h*.96,'#4b4743',10); line(x+w*.66,y+h*.80,x+w*.78,y+h*.96,'#4b4743',10);
        return true;
    }

    if (it.type === 'sofa') {
        sgAdd('rect',{x:x+8,y:y+8,width:w-16,height:h-16,rx:58,fill:'url(#sofaGrad)',stroke:'#817566','stroke-width':12});
        add('rect',{x:x+w*.055,y:y+h*.14,width:w*.89,height:h*.68,rx:45,fill:'#e4dccf',stroke:'#afa493','stroke-width':8});
        add('rect',{x:x+w*.03,y:y+h*.12,width:w*.10,height:h*.72,rx:30,fill:'#c4b8a7',stroke:'#958979','stroke-width':7});
        add('rect',{x:x+w*.87,y:y+h*.12,width:w*.10,height:h*.72,rx:30,fill:'#c4b8a7',stroke:'#958979','stroke-width':7});
        const seats = w > 1500 ? 3 : 2;
        for(let i=1;i<seats;i++) line(x+w*(.14+(i*(.72/seats))),y+h*.20,x+w*(.14+(i*(.72/seats))),y+h*.76,'#b9ad9c',7,.8);
        line(x+w*.16,y+h*.39,x+w*.84,y+h*.39,'#c1b5a4',6,.8);
        return true;
    }

    if (it.type === 'storage') {
        sgAdd('rect',{x:x+8,y:y+8,width:w-16,height:h-16,rx:25,fill:'#e8e2d8',stroke:'#685f55','stroke-width':12});
        const horizontal=w>=h;
        if(horizontal){
            [1/3,2/3].forEach(r=>line(x+w*r,y+28,x+w*r,y+h-28,'#a69b8e',7));
            [1/6,1/2,5/6].forEach(r=>add('circle',{cx:x+w*r,cy:y+h*.53,r:Math.max(9,Math.min(w,h)*.035),fill:'#74695e'}));
        } else {
            [1/3,2/3].forEach(r=>line(x+28,y+h*r,x+w-28,y+h*r,'#a69b8e',7));
            [1/6,1/2,5/6].forEach(r=>add('circle',{cx:x+w*.52,cy:y+h*r,r:Math.max(9,Math.min(w,h)*.035),fill:'#74695e'}));
        }
        return true;
    }

    if (it.type === 'table') {
        const topX=x+w*.11, topY=y+h*.18, topW=w*.78, topH=h*.64;
        sgAdd('rect',{x:topX,y:topY,width:topW,height:topH,rx:42,fill:'url(#woodFurniture)',stroke:'#76563b','stroke-width':11});
        [0.30,0.48,0.66].forEach(r=>line(topX+35,topY+topH*r,topX+topW-35,topY+topH*(r-.025),'#865f3e',5,.3));
        const cfill='#b9afa2', cstroke='#6d645b';
        const chairs=[
            [x+w*.21,y+h*.015,w*.19,h*.15],[x+w*.60,y+h*.015,w*.19,h*.15],
            [x+w*.21,y+h*.835,w*.19,h*.15],[x+w*.60,y+h*.835,w*.19,h*.15]
        ];
        chairs.forEach(([cx,cy,cw,ch])=>add('rect',{x:cx,y:cy,width:cw,height:ch,rx:22,fill:cfill,stroke:cstroke,'stroke-width':7,filter:'url(#softInner)'}));
        add('circle',{cx:x+w*.50,cy:y+h*.50,r:Math.max(18,Math.min(w,h)*.045),fill:'#eee5d5',stroke:'#9d896d','stroke-width':5});
        return true;
    }

    if (it.type === 'tv') {
        sgAdd('rect',{x:x+10,y:y+h*.46,width:w-20,height:h*.45,rx:25,fill:'#c6aa85',stroke:'#685845','stroke-width':11});
        add('rect',{x:x+w*.10,y:y+h*.05,width:w*.80,height:h*.54,rx:18,fill:'#252a2f',stroke:'#111519','stroke-width':10});
        add('rect',{x:x+w*.135,y:y+h*.09,width:w*.73,height:h*.43,rx:10,fill:'#516d7c'});
        add('path',{d:`M ${x+w*.17} ${y+h*.14} Q ${x+w*.44} ${y+h*.05} ${x+w*.77} ${y+h*.36}`,fill:'none',stroke:'#8fb4c6','stroke-width':9,opacity:.42});
        line(x+w*.5,y+h*.59,x+w*.5,y+h*.69,'#383b3f',12); line(x+w*.38,y+h*.69,x+w*.62,y+h*.69,'#383b3f',10);
        [0.25,0.5,0.75].forEach(r=>line(x+w*r,y+h*.70,x+w*r,y+h*.88,'#8d7559',5,.7));
        return true;
    }

    if (it.type === 'fridge') {
        sgAdd('rect',{x:x+8,y:y+8,width:w-16,height:h-16,rx:30,fill:'#d9dcdf',stroke:'#60666b','stroke-width':12});
        add('rect',{x:x+35,y:y+35,width:w-70,height:h-70,rx:24,fill:'#eceff1',stroke:'#9da3a8','stroke-width':7});
        line(x+w*.50,y+45,x+w*.50,y+h-45,'#a9afb4',7);
        add('rect',{x:x+w*.445,y:y+h*.18,width:w*.035,height:h*.28,rx:10,fill:'#7c8287'});
        add('rect',{x:x+w*.52,y:y+h*.18,width:w*.035,height:h*.28,rx:10,fill:'#7c8287'});
        add('rect',{x:x+w*.58,y:y+h*.12,width:w*.20,height:h*.13,rx:10,fill:'#a8bdc9',stroke:'#737e84','stroke-width':5});
        return true;
    }

    return false;
}

function drawItemDetail(g, it, x, y, w, h) {

    if (drawDetailedFurniture(g, it, x, y, w, h)) return;

    // =========================
    // 침대
    // =========================
    if (it.type === 'bed') {

        const frame = addSvg('rect', {
            x, y,
            width: w,
            height: h,
            rx: 50,
            fill: '#eee9e1',
            stroke: '#6b6259',
            'stroke-width': 18
        });

        g.appendChild(frame);

        // 머리판
        g.appendChild(addSvg('rect', {
            x: x + 25,
            y: y + 25,
            width: w - 50,
            height: h * 0.11,
            rx: 20,
            fill: '#8a6847'
        }));

        // 매트리스
        g.appendChild(addSvg('rect', {
            x: x + 65,
            y: y + h * 0.12,
            width: w - 130,
            height: h * 0.82,
            rx: 35,
            fill: '#f7f4ee',
            stroke: '#c7c0b7',
            'stroke-width': 12
        }));

        // 베개 2개
        const pillowW = (w - 190) / 2;

        [0, 1].forEach(i => {
            g.appendChild(addSvg('rect', {
                x: x + 80 + i * (pillowW + 30),
                y: y + h * 0.16,
                width: pillowW,
                height: h * 0.18,
                rx: 35,
                fill: '#ffffff',
                stroke: '#aaa',
                'stroke-width': 10
            }));
        });

        // 이불
        g.appendChild(addSvg('rect', {
            x: x + 85,
            y: y + h * 0.38,
            width: w - 170,
            height: h * 0.51,
            rx: 30,
            fill: '#e4ddd1'
        }));

        return;
    }


    // =========================
    // 욕실
    // =========================
    if (it.type === 'bathroom') {

        g.appendChild(addSvg('rect', {
            x, y,
            width: w,
            height: h,
            fill: '#cbd5df',
            stroke: '#444',
            'stroke-width': 18
        }));

        // 타일
        const tile = Math.max(150, Math.min(w, h) / 6);

        for (let tx = x; tx < x + w; tx += tile) {
            g.appendChild(addSvg('line', {
                x1: tx,
                y1: y,
                x2: tx,
                y2: y + h,
                stroke: '#e5ebf0',
                'stroke-width': 6
            }));
        }

        for (let ty = y; ty < y + h; ty += tile) {
            g.appendChild(addSvg('line', {
                x1: x,
                y1: ty,
                x2: x + w,
                y2: ty,
                stroke: '#e5ebf0',
                'stroke-width': 6
            }));
        }

        // 변기
        g.appendChild(addSvg('ellipse', {
            cx: x + w * 0.23,
            cy: y + h * 0.30,
            rx: w * 0.13,
            ry: h * 0.17,
            fill: '#fff',
            stroke: '#777',
            'stroke-width': 10
        }));

        g.appendChild(addSvg('rect', {
            x: x + w * 0.10,
            y: y + h * 0.08,
            width: w * 0.26,
            height: h * 0.09,
            rx: 15,
            fill: '#fff',
            stroke: '#777',
            'stroke-width': 10
        }));

        // 세면대
        g.appendChild(addSvg('rect', {
            x: x + w * 0.08,
            y: y + h * 0.62,
            width: w * 0.32,
            height: h * 0.20,
            rx: 20,
            fill: '#fff',
            stroke: '#777',
            'stroke-width': 10
        }));

        g.appendChild(addSvg('ellipse', {
            cx: x + w * 0.24,
            cy: y + h * 0.72,
            rx: w * 0.09,
            ry: h * 0.055,
            fill: '#dbe5ea'
        }));

        // 문
        g.appendChild(addSvg('path', {
            d: `
                M ${x + w * 0.63} ${y + h}
                L ${x + w * 0.63} ${y + h * 0.70}
                A ${w * 0.37} ${h * 0.30}
                0 0 1
                ${x + w} ${y + h}
            `,
            fill: 'none',
            stroke: '#555',
            'stroke-width': 10
        }));

        return;
    }


    // =========================
    // 책상
    // =========================
    if (it.type === 'desk') {

        g.appendChild(addSvg('rect', {
            x, y,
            width: w,
            height: h,
            rx: 25,
            fill: '#b88955',
            stroke: '#5d4835',
            'stroke-width': 15
        }));

        // 나무 느낌
        for (let i = 1; i < 5; i++) {
            g.appendChild(addSvg('line', {
                x1: x,
                y1: y + h * (i / 5),
                x2: x + w,
                y2: y + h * (i / 5),
                stroke: '#a37749',
                'stroke-width': 5
            }));
        }

        // 모니터
        g.appendChild(addSvg('rect', {
            x: x + w * 0.58,
            y: y + h * 0.12,
            width: w * 0.25,
            height: h * 0.25,
            rx: 10,
            fill: '#333'
        }));

        // 키보드
        g.appendChild(addSvg('rect', {
            x: x + w * 0.52,
            y: y + h * 0.50,
            width: w * 0.32,
            height: h * 0.15,
            rx: 8,
            fill: '#ddd'
        }));

        return;
    }


    // =========================
    // 의자
    // =========================
    if (it.type === 'chair') {

        g.appendChild(addSvg('rect', {
            x: x + w * 0.18,
            y: y + h * 0.20,
            width: w * 0.64,
            height: h * 0.62,
            rx: w * 0.18,
            fill: '#444',
            stroke: '#222',
            'stroke-width': 12
        }));

        g.appendChild(addSvg('rect', {
            x: x + w * 0.25,
            y: y + h * 0.03,
            width: w * 0.50,
            height: h * 0.25,
            rx: 25,
            fill: '#333'
        }));

        return;
    }


    // =========================
    // 소파
    // =========================
    if (it.type === 'sofa') {

        g.appendChild(addSvg('rect', {
            x, y,
            width: w,
            height: h,
            rx: 45,
            fill: '#ded7ca',
            stroke: '#777',
            'stroke-width': 15
        }));

        g.appendChild(addSvg('line', {
            x1: x + w / 2,
            y1: y + 60,
            x2: x + w / 2,
            y2: y + h - 60,
            stroke: '#aaa',
            'stroke-width': 10
        }));

        return;
    }


    // =========================
    // 싱크대: 일자형 / ㄱ자형 / ㄷ자형
    // =========================
    if (['sinkStraight', 'sinkL', 'sinkU'].includes(it.type)) {
        const depth = Math.max(180, Math.min(Math.min(w, h) * 0.32, 650));
        const fill = '#e2ddd1';
        const stroke = '#555';

        if (it.type === 'sinkStraight') {
            g.appendChild(addSvg('rect', {
                x, y, width: w, height: h,
                fill, stroke, 'stroke-width': 18
            }));
        } else if (it.type === 'sinkL') {
            g.appendChild(addSvg('path', {
                d: `M ${x} ${y} H ${x + w} V ${y + depth} H ${x + depth} V ${y + h} H ${x} Z`,
                fill, stroke, 'stroke-width': 18, 'stroke-linejoin': 'round'
            }));
        } else {
            g.appendChild(addSvg('path', {
                d: `M ${x} ${y} H ${x + w} V ${y + h} H ${x + w - depth} V ${y + depth} H ${x + depth} V ${y + h} H ${x} Z`,
                fill, stroke, 'stroke-width': 18, 'stroke-linejoin': 'round'
            }));
        }

        // 싱크볼
        const sinkW = Math.min(w * 0.24, 520);
        const sinkH = Math.min(depth * 0.58, 360);
        g.appendChild(addSvg('rect', {
            x: x + depth * 0.28,
            y: y + Math.max(35, (depth - sinkH) / 2),
            width: sinkW,
            height: sinkH,
            rx: 20,
            fill: '#c9ced1',
            stroke: '#666',
            'stroke-width': 10
        }));

        // 쿡탑
        const stoveX = x + Math.max(depth + 180, w * 0.68);
        const stoveY = y + Math.min(depth * 0.48, h * 0.25);
        const burnerR = Math.max(35, Math.min(70, Math.min(w, h) * 0.045));
        [0, 1].forEach(row => {
            [0, 1].forEach(col => {
                g.appendChild(addSvg('circle', {
                    cx: Math.min(x + w - burnerR * 1.5, stoveX + col * burnerR * 2.4),
                    cy: Math.min(y + Math.max(depth - burnerR * 1.3, burnerR * 1.5), stoveY + row * burnerR * 2.4),
                    r: burnerR,
                    fill: '#333'
                }));
            });
        });
        return;
    }

    // =========================
    // 아일랜드 식탁
    // =========================
    if (it.type === 'island') {
        g.appendChild(addSvg('rect', {
            x, y, width: w, height: h,
            rx: 28,
            fill: '#d9c6a8',
            stroke: '#665847',
            'stroke-width': 16
        }));
        g.appendChild(addSvg('rect', {
            x: x + 45, y: y + 45, width: Math.max(20, w - 90), height: Math.max(20, h - 90),
            rx: 20,
            fill: '#eadcc5',
            stroke: '#9a8467',
            'stroke-width': 8
        }));

        const stoolR = Math.max(45, Math.min(90, h * 0.12));
        [0.25, 0.5, 0.75].forEach(p => {
            g.appendChild(addSvg('circle', {
                cx: x + w * p,
                cy: y + h - stoolR * 0.95,
                r: stoolR,
                fill: '#b8aa96',
                stroke: '#6f6252',
                'stroke-width': 8
            }));
        });
        return;
    }


    // =========================
    // 현관: 바닥은 실내, 문짝/열림호는 외벽 바깥으로 표시
    // =========================
    if (it.type === 'entrance') {
        const side = it.wallSide || 'bottom';

        g.appendChild(addSvg('rect', {
            x, y, width: w, height: h,
            fill: '#ddd7ca', stroke: '#666', 'stroke-width': 15
        }));

        // 현관 바닥 타일
        for (let i = 1; i < 4; i++) {
            g.appendChild(addSvg('line', {
                x1: x, y1: y + h * i / 4, x2: x + w, y2: y + h * i / 4,
                stroke: '#c6bfae', 'stroke-width': 5
            }));
        }

        const door = Math.min(850, side === 'left' || side === 'right' ? h * 0.72 : w * 0.72);
        const stroke = 12;
        const arcStroke = 7;

        const flipped = !!it.flipX;
        if (side === 'right') {
            const y0 = y + (h - door) / 2;
            const hingeY = flipped ? y0 + door : y0;
            const endY = flipped ? y0 + door : y0;
            g.appendChild(addSvg('line', { x1:x+w, y1:hingeY, x2:x+w+door, y2:endY, stroke:'#555', 'stroke-width':stroke }));
            g.appendChild(addSvg('path', {
                d: flipped
                    ? `M ${x+w} ${y0} A ${door} ${door} 0 0 1 ${x+w+door} ${y0+door}`
                    : `M ${x+w} ${y0+door} A ${door} ${door} 0 0 0 ${x+w+door} ${y0}`,
                fill:'none', stroke:'#999', 'stroke-width':arcStroke
            }));
        } else if (side === 'left') {
            const y0 = y + (h - door) / 2;
            const hingeY = flipped ? y0 + door : y0;
            const endY = flipped ? y0 + door : y0;
            g.appendChild(addSvg('line', { x1:x, y1:hingeY, x2:x-door, y2:endY, stroke:'#555', 'stroke-width':stroke }));
            g.appendChild(addSvg('path', {
                d: flipped
                    ? `M ${x} ${y0} A ${door} ${door} 0 0 0 ${x-door} ${y0+door}`
                    : `M ${x} ${y0+door} A ${door} ${door} 0 0 1 ${x-door} ${y0}`,
                fill:'none', stroke:'#999', 'stroke-width':arcStroke
            }));
        } else if (side === 'top') {
            const x0 = x + (w - door) / 2;
            const hingeX = flipped ? x0 + door : x0;
            const endX = flipped ? x0 + door : x0;
            g.appendChild(addSvg('line', { x1:hingeX, y1:y, x2:endX, y2:y-door, stroke:'#555', 'stroke-width':stroke }));
            g.appendChild(addSvg('path', {
                d: flipped
                    ? `M ${x0} ${y} A ${door} ${door} 0 0 1 ${x0+door} ${y-door}`
                    : `M ${x0+door} ${y} A ${door} ${door} 0 0 0 ${x0} ${y-door}`,
                fill:'none', stroke:'#999', 'stroke-width':arcStroke
            }));
        } else {
            const x0 = x + (w - door) / 2;
            const hingeX = flipped ? x0 + door : x0;
            const endX = flipped ? x0 + door : x0;
            g.appendChild(addSvg('line', { x1:hingeX, y1:y+h, x2:endX, y2:y+h+door, stroke:'#555', 'stroke-width':stroke }));
            g.appendChild(addSvg('path', {
                d: flipped
                    ? `M ${x0} ${y+h} A ${door} ${door} 0 0 0 ${x0+door} ${y+h+door}`
                    : `M ${x0+door} ${y+h} A ${door} ${door} 0 0 1 ${x0} ${y+h+door}`,
                fill:'none', stroke:'#999', 'stroke-width':arcStroke
            }));
        }
        return;
    }


    // =========================
    // 창문은 벽 중심선에 겹쳐 표시. 중문은 자유 이동하되 둘 다 두께는 고정
    // =========================
    if (it.type === 'window') {
        const mid = y + h / 2;
        g.appendChild(addSvg('rect', { x, y, width:w, height:h, fill:'#eef7ff', stroke:'#4f6f8f', 'stroke-width':12 }));
        g.appendChild(addSvg('line', { x1:x+25, y1:mid-22, x2:x+w-25, y2:mid-22, stroke:'#5d82a6', 'stroke-width':10 }));
        g.appendChild(addSvg('line', { x1:x+25, y1:mid+22, x2:x+w-25, y2:mid+22, stroke:'#5d82a6', 'stroke-width':10 }));
        return;
    }
    if (it.type === 'middleDoor') {
        const mid = y + h / 2;
        g.appendChild(addSvg('rect', { x, y, width:w, height:h, fill:'#f4eee4', stroke:'#6d6257', 'stroke-width':12 }));
        g.appendChild(addSvg('line', { x1:x+20, y1:mid, x2:x+w-20, y2:mid, stroke:'#8b7763', 'stroke-width':12 }));
        const panel = Math.max(120, w / 3);
        g.appendChild(addSvg('line', { x1:x+panel, y1:y+10, x2:x+panel, y2:y+h-10, stroke:'#9a8874', 'stroke-width':7 }));
        g.appendChild(addSvg('line', { x1:x+w-panel, y1:y+10, x2:x+w-panel, y2:y+h-10, stroke:'#9a8874', 'stroke-width':7 }));
        return;
    }

    // =========================
    // 붙박이장: 단순 사각형 대신 문짝/분할/손잡이가 보이는 평면 표현
    // =========================
    if (it.type === 'closet') {
        const inset = Math.max(35, Math.min(w, h) * 0.05);
        g.appendChild(addSvg('rect', {
            x, y, width:w, height:h,
            rx:Math.min(24, Math.min(w,h)/8),
            fill:'#ddd6c8', stroke:'#625a50', 'stroke-width':12
        }));
        g.appendChild(addSvg('rect', {
            x:x+inset, y:y+inset, width:Math.max(10,w-inset*2), height:Math.max(10,h-inset*2),
            fill:'#eee9df', stroke:'#8d8376', 'stroke-width':6
        }));

        // 긴 방향을 따라 3칸 문짝으로 나눈다.
        if (w >= h) {
            [1/3, 2/3].forEach(r => g.appendChild(addSvg('line', {
                x1:x+w*r, y1:y+inset, x2:x+w*r, y2:y+h-inset,
                stroke:'#9b9184', 'stroke-width':6
            })));
            [1/3, 2/3].forEach(r => g.appendChild(addSvg('circle', {
                cx:x+w*r-22, cy:y+h/2, r:12, fill:'#625a50'
            })));
        } else {
            [1/3, 2/3].forEach(r => g.appendChild(addSvg('line', {
                x1:x+inset, y1:y+h*r, x2:x+w-inset, y2:y+h*r,
                stroke:'#9b9184', 'stroke-width':6
            })));
            [1/3, 2/3].forEach(r => g.appendChild(addSvg('circle', {
                cx:x+w/2, cy:y+h*r-22, r:12, fill:'#625a50'
            })));
        }
        return;
    }



    // =========================
    // 수납장
    // =========================
    if (it.type === 'storage') {
        const inset = Math.max(24, Math.min(w, h) * 0.08);
        g.appendChild(addSvg('rect', {
            x, y, width:w, height:h, rx:24,
            fill:'#d8d0c3', stroke:'#625a50', 'stroke-width':12
        }));
        g.appendChild(addSvg('rect', {
            x:x+inset, y:y+inset, width:Math.max(10,w-inset*2), height:Math.max(10,h-inset*2),
            fill:'#eee9df', stroke:'#91877a', 'stroke-width':6
        }));
        if (w >= h) {
            [1/3,2/3].forEach(r => g.appendChild(addSvg('line', {
                x1:x+w*r, y1:y+inset, x2:x+w*r, y2:y+h-inset,
                stroke:'#9d9488', 'stroke-width':6
            })));
            [1/3,2/3].forEach(r => g.appendChild(addSvg('circle', {
                cx:x+w*r-18, cy:y+h/2, r:10, fill:'#625a50'
            })));
        } else {
            [1/3,2/3].forEach(r => g.appendChild(addSvg('line', {
                x1:x+inset, y1:y+h*r, x2:x+w-inset, y2:y+h*r,
                stroke:'#9d9488', 'stroke-width':6
            })));
            [1/3,2/3].forEach(r => g.appendChild(addSvg('circle', {
                cx:x+w/2, cy:y+h*r-18, r:10, fill:'#625a50'
            })));
        }
        return;
    }

    // =========================
    // 식탁
    // =========================
    if (it.type === 'table') {
        g.appendChild(addSvg('rect', {
            x:x+w*0.12, y:y+h*0.18, width:w*0.76, height:h*0.64,
            rx:32, fill:'#c9a878', stroke:'#6f573b', 'stroke-width':12
        }));
        const chairFill = '#8d7d69';
        const chairStroke = '#5d5144';
        const cw = Math.max(70, w*0.16), ch = Math.max(55, h*0.16);
        [[x+w*0.22,y+h*0.02],[x+w*0.62,y+h*0.02],[x+w*0.22,y+h*0.82],[x+w*0.62,y+h*0.82]].forEach(([cx,cy]) => {
            g.appendChild(addSvg('rect',{x:cx,y:cy,width:cw,height:ch,rx:18,fill:chairFill,stroke:chairStroke,'stroke-width':7}));
        });
        return;
    }

    // =========================
    // TV장
    // =========================
    if (it.type === 'tv') {
        g.appendChild(addSvg('rect', {
            x, y, width:w, height:h, rx:24,
            fill:'#d7c7b2', stroke:'#665849', 'stroke-width':12
        }));
        g.appendChild(addSvg('rect', {
            x:x+w*0.12, y:y+h*0.18, width:w*0.76, height:h*0.38,
            rx:10, fill:'#34383d', stroke:'#1f2327', 'stroke-width':8
        }));
        g.appendChild(addSvg('line', {
            x1:x+w*0.5, y1:y+h*0.56, x2:x+w*0.5, y2:y+h*0.76,
            stroke:'#444', 'stroke-width':10
        }));
        g.appendChild(addSvg('line', {
            x1:x+w*0.35, y1:y+h*0.76, x2:x+w*0.65, y2:y+h*0.76,
            stroke:'#444', 'stroke-width':10
        }));
        [0.25,0.5,0.75].forEach(r => g.appendChild(addSvg('line', {
            x1:x+w*r, y1:y+h*0.82, x2:x+w*r, y2:y+h*0.96,
            stroke:'#8d7b65', 'stroke-width':5
        })));
        return;
    }

    // =========================
    // 내부 벽
    // =========================
    if (it.type === 'wall') {
        g.appendChild(addSvg('rect', {
            x, y, width: w, height: h,
            rx: Math.min(12, Math.min(w, h) / 5),
            fill: '#333', stroke: '#111', 'stroke-width': 8,
            class: 'wall-detail'
        }));
        return;
    }

    // =========================
    // 기본 fallback
    // =========================
    g.appendChild(addSvg('rect', {
        x, y,
        width: w,
        height: h,
        rx: Math.min(40, w / 12),
        fill: it.color,
        stroke: '#555',
        'stroke-width': 12
    }));
}

function entranceSideFromRotation(rot) {
    const r = normalizeRotation(rot || 0);
    return ({0:'bottom', 90:'right', 180:'top', 270:'left'})[r] || 'bottom';
}

function entranceRotationFromSide(side) {
    return ({bottom:0, right:90, top:180, left:270})[side] ?? 0;
}

function snapEntranceToWall(it, preferredSide = null) {
    if (!it || it.type !== 'entrance') return;

    normalizeLShapeRoom();
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    let candidates = roomBoundarySegments().filter(seg => entranceFitsSegment(it, seg));

    // 회전 버튼으로 방향을 지정한 경우 해당 방향의 실제 외벽 구간만 후보로 사용한다.
    if (preferredSide) {
        const sameSide = candidates.filter(seg => seg.side === preferredSide);
        if (sameSide.length) candidates = sameSide;
    }

    // ㄱ자형에서는 단순 bounding box의 top/right가 아니라 실제 6개 외벽 구간 중 가장 가까운 곳에 붙인다.
    const seg = candidates.reduce((best, current) => {
        if (!best) return current;
        return distanceToSegment(cx, cy, current) < distanceToSegment(cx, cy, best) ? current : best;
    }, null);

    if (!seg) return;
    placeEntranceOnSegment(it, seg);
}

function rotateEntranceWall(it, direction) {
    const order = ['top','right','bottom','left'];
    const current = it.wallSide || 'bottom';
    let idx = order.indexOf(current);
    idx = (idx + (direction === 'right' ? 1 : -1) + order.length) % order.length;
    snapEntranceToWall(it, order[idx]);
}

const FIXTURE_THICKNESS = 120;
function isWallFixture(it) { return !!it && it.type === 'window'; }
function isFixedThicknessControl(it) { return !!it && (it.type === 'window' || it.type === 'middleDoor'); }

function fixtureSegments() {
    const segments = roomBoundarySegments().map(seg => ({ ...seg, source: 'room', id: `room:${seg.key}` }));
    state.items.filter(i => i.type === 'wall').forEach(wall => {
        const b = getRenderedBounds(wall);
        if (b.w >= b.h) {
            segments.push({ id:`wall:${wall.id}`, source:'wall', wallId:wall.id, key:`wall:${wall.id}`, side:'center', orientation:'h', x1:b.x, y1:b.y+b.h/2, x2:b.x+b.w, y2:b.y+b.h/2 });
        } else {
            segments.push({ id:`wall:${wall.id}`, source:'wall', wallId:wall.id, key:`wall:${wall.id}`, side:'center', orientation:'v', x1:b.x+b.w/2, y1:b.y, x2:b.x+b.w/2, y2:b.y+b.h });
        }
    });
    return segments;
}

function setFixtureRenderedRect(it, rx, ry, length, orientation) {
    it.w = Math.max(300, Math.round(length / 10) * 10);
    it.h = FIXTURE_THICKNESS;
    it.rot = orientation === 'v' ? 90 : 0;
    if (it.rot === 0) {
        it.x = Math.round(rx / 10) * 10;
        it.y = Math.round(ry / 10) * 10;
    } else {
        const d = (it.w - it.h) / 2;
        it.x = Math.round((rx - d) / 10) * 10;
        it.y = Math.round((ry + d) / 10) * 10;
    }
}

function snapWallFixture(it, preferredSegmentId = null) {
    if (!isWallFixture(it)) return;
    const b = getRenderedBounds(it);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const all = fixtureSegments().filter(seg => {
        const len = seg.orientation === 'h' ? Math.abs(seg.x2-seg.x1) : Math.abs(seg.y2-seg.y1);
        return len >= 300;
    });
    let candidates = all;
    if (preferredSegmentId) {
        const same = all.filter(seg => seg.id === preferredSegmentId);
        if (same.length) candidates = same;
    } else if (it.wallKey) {
        const same = all.filter(seg => seg.id === it.wallKey);
        if (same.length) candidates = same;
    }
    const seg = candidates.reduce((best, current) => {
        if (!best) return current;
        return distanceToSegment(cx, cy, current) < distanceToSegment(cx, cy, best) ? current : best;
    }, null);
    if (!seg) return;
    const segLength = seg.orientation === 'h' ? Math.abs(seg.x2-seg.x1) : Math.abs(seg.y2-seg.y1);
    const length = Math.min(it.w || 900, segLength);
    it.wallKey = seg.id;
    if (seg.orientation === 'h') {
        const minX = Math.min(seg.x1,seg.x2), maxX = Math.max(seg.x1,seg.x2)-length;
        const start = clamp(cx-length/2, minX, Math.max(minX,maxX));
        setFixtureRenderedRect(it, start, seg.y1-FIXTURE_THICKNESS/2, length, 'h');
    } else {
        const minY = Math.min(seg.y1,seg.y2), maxY = Math.max(seg.y1,seg.y2)-length;
        const start = clamp(cy-length/2, minY, Math.max(minY,maxY));
        setFixtureRenderedRect(it, seg.x1-FIXTURE_THICKNESS/2, start, length, 'v');
    }
}

function rotateWallFixture(it, rot) {
    const targetOrientation = (+rot === 90 || +rot === 270) ? 'v' : 'h';
    const b = getRenderedBounds(it), cx=b.x+b.w/2, cy=b.y+b.h/2;
    const segs = fixtureSegments().filter(seg => seg.orientation === targetOrientation);
    const seg = segs.reduce((best,current) => !best || distanceToSegment(cx,cy,current) < distanceToSegment(cx,cy,best) ? current : best, null);
    it.wallKey = seg?.id || null;
    if (seg) snapWallFixture(it, seg.id);
}

function normalizeRotation(rot) {
    return ((rot % 360) + 360) % 360;
}

// 좌우 반전이 의미 있는 비대칭/비정형 컨트롤.
// 이후 새로운 비정형 컨트롤을 추가할 때 이 목록에 type만 추가하면 된다.
const FLIPPABLE_ITEM_TYPES = new Set(['sinkL', 'sinkU', 'entrance']);

function canFlipItem(it) {
    return !!it && FLIPPABLE_ITEM_TYPES.has(it.type);
}

// 화면에 실제로 보이는 회전 후 가로/세로 크기
function getRenderedSize(it) {
    const rot = normalizeRotation(it.rot || 0);
    if (rot === 90 || rot === 270) {
        return { w: it.h, h: it.w };
    }
    return { w: it.w, h: it.h };
}

// SVG가 중심점을 기준으로 회전되므로, 실제 화면상의 bounding box를 계산한다.
function getRenderedBounds(it, x = it.x, y = it.y) {
    const rot = normalizeRotation(it.rot || 0);

    if (rot === 90 || rot === 270) {
        return {
            x: x + (it.w - it.h) / 2,
            y: y + (it.h - it.w) / 2,
            w: it.h,
            h: it.w
        };
    }

    return { x, y, w: it.w, h: it.h };
}

function rotateVector(x, y, degrees) {
    const r = degrees * Math.PI / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return {
        x: x * cos - y * sin,
        y: x * sin + y * cos
    };
}

function addResizeHandles(g, it, itemX, itemY) {
    if (it.id !== state.selectedId) return;

    if (isFixedThicknessControl(it)) {
        const size = 70, half = size / 2;
        [['w', itemX, itemY + it.h/2], ['e', itemX + it.w, itemY + it.h/2]].forEach(([edge,x,y]) => {
            const handle = addSvg('rect', { x:x-half, y:y-half, width:size, height:size, rx:half, class:'resize-handle', 'data-corner':edge });
            handle.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); startFixtureResize(e, it.id); });
            g.appendChild(handle);
        });
        return;
    }

    // 기존 핸들보다 약 50% 작게 표시한다.
    const size = Math.max(55, Math.min(90, Math.min(it.w, it.h) * 0.06));
    const half = size / 2;
    const corners = {
        nw: [itemX, itemY],
        ne: [itemX + it.w, itemY],
        se: [itemX + it.w, itemY + it.h],
        sw: [itemX, itemY + it.h]
    };

    Object.entries(corners).forEach(([corner, [x, y]]) => {
        const handle = addSvg('rect', {
            x: x - half,
            y: y - half,
            width: size,
            height: size,
            rx: size / 2,
            class: 'resize-handle',
            'data-corner': corner
        });

        handle.addEventListener('pointerdown', e => {
            e.preventDefault();
            e.stopPropagation();
            startResize(e, it.id, corner);
        });

        g.appendChild(handle);
    });
}

function startFixtureResize(e, id) {
    const it = state.items.find(x => x.id === id);
    if (!isFixedThicknessControl(it)) return;
    e.preventDefault(); e.stopPropagation(); closeContextMenu();
    state.selectedId = id; pushHistory();
    const b = getRenderedBounds(it);
    resizeDrag = { id, mode:'fixture', center:{x:b.x+b.w/2,y:b.y+b.h/2}, rot:normalizeRotation(it.rot||0), wallKey:it.wallKey, snapToWall:isWallFixture(it) };
    document.addEventListener('pointermove', onResize);
    document.addEventListener('pointerup', endResize, { once:true });
}

function startResize(e, id, corner) {
    const it = state.items.find(x => x.id === id);
    if (!it) return;

    closeContextMenu();
    state.selectedId = id;
    pushHistory();

    const rot = normalizeRotation(it.rot || 0);
    const center = { x: it.x + it.w / 2, y: it.y + it.h / 2 };
    const signs = {
        nw: [-1, -1],
        ne: [1, -1],
        se: [1, 1],
        sw: [-1, 1]
    };
    const [sx, sy] = signs[corner];

    const oppositeLocal = { x: -sx * it.w / 2, y: -sy * it.h / 2 };
    const oppositeRotated = rotateVector(oppositeLocal.x, oppositeLocal.y, rot);
    const anchor = {
        x: center.x + oppositeRotated.x,
        y: center.y + oppositeRotated.y
    };

    resizeDrag = {
        id,
        corner,
        sx,
        sy,
        rot,
        anchor,
        minW: it.type === 'wall' ? 60 : 200,
        minH: it.type === 'wall' ? 60 : 200
    };

    document.addEventListener('pointermove', onResize);
    document.addEventListener('pointerup', endResize, { once: true });
}

function onResize(e) {
    if (!resizeDrag) return;

    const it = state.items.find(x => x.id === resizeDrag.id);
    if (!it) return;

    const pointer = svgPoint(e);
    if (resizeDrag.mode === 'fixture') {
        const d = rotateVector(pointer.x - resizeDrag.center.x, pointer.y - resizeDrag.center.y, -resizeDrag.rot);
        it.w = Math.max(300, Math.round((Math.abs(d.x) * 2) / 10) * 10);
        it.h = FIXTURE_THICKNESS;
        if (resizeDrag.snapToWall) snapWallFixture(it, resizeDrag.wallKey);
        render();
        return;
    }
    const deltaWorld = {
        x: pointer.x - resizeDrag.anchor.x,
        y: pointer.y - resizeDrag.anchor.y
    };
    const deltaLocal = rotateVector(deltaWorld.x, deltaWorld.y, -resizeDrag.rot);

    let newW = Math.max(resizeDrag.minW, resizeDrag.sx * deltaLocal.x);
    let newH = Math.max(resizeDrag.minH, resizeDrag.sy * deltaLocal.y);

    // 10mm 단위로 맞춰서 도면 치수가 너무 세밀해지지 않도록 한다.
    newW = Math.round(newW / 10) * 10;
    newH = Math.round(newH / 10) * 10;

    const centerOffsetLocal = {
        x: resizeDrag.sx * newW / 2,
        y: resizeDrag.sy * newH / 2
    };
    const centerOffsetWorld = rotateVector(centerOffsetLocal.x, centerOffsetLocal.y, resizeDrag.rot);
    const newCenter = {
        x: resizeDrag.anchor.x + centerOffsetWorld.x,
        y: resizeDrag.anchor.y + centerOffsetWorld.y
    };

    const nx = newCenter.x - newW / 2;
    const ny = newCenter.y - newH / 2;

    const test = { ...it, x: nx, y: ny, w: newW, h: newH };
    if (fitsInRoom(test, nx, ny)) {
        it.x = Math.round(nx / 10) * 10;
        it.y = Math.round(ny / 10) * 10;
        it.w = newW;
        it.h = newH;
        if (it.type === 'entrance') snapEntranceToWall(it, it.wallSide || 'bottom');
    }

    render();
}

function endResize() {
    resizeDrag = null;
    document.removeEventListener('pointermove', onResize);
}

function openContextMenu(e, id) {
    e.preventDefault();
    e.stopPropagation();

    state.selectedId = id;
    contextItemId = id;
    render();

    const menu = $('#itemContextMenu');
    if (!menu) return;

    const it = state.items.find(x => x.id === id);
    const flipButton = menu.querySelector('[data-context-action="flipHorizontal"]');
    const flipSeparator = menu.querySelector('[data-flip-separator]');
    const showFlip = canFlipItem(it);
    flipButton?.classList.toggle('hidden', !showFlip);
    flipSeparator?.classList.toggle('hidden', !showFlip);

    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');

    // 우측/하단 화면 밖으로 넘어가지 않게 위치 보정
    const pad = 8;
    const menuW = menu.offsetWidth;
    const menuH = menu.offsetHeight;
    const left = Math.min(e.clientX, window.innerWidth - menuW - pad);
    const top = Math.min(e.clientY, window.innerHeight - menuH - pad);

    menu.style.left = Math.max(pad, left) + 'px';
    menu.style.top = Math.max(pad, top) + 'px';
}

function closeContextMenu() {
    const menu = $('#itemContextMenu');
    if (!menu) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    contextItemId = null;
}

function rotateContextItem(direction) {
    const it = state.items.find(x => x.id === contextItemId);
    if (!it) return;
    pushHistory();
    const amount = direction === 'left' ? -90 : 90;
    if (it.type === 'entrance') rotateEntranceWall(it, direction);
    else if (isWallFixture(it)) rotateWallFixture(it, normalizeRotation((it.rot || 0) + amount));
    else it.rot = normalizeRotation((it.rot || 0) + amount);
    state.selectedId = it.id;
    closeContextMenu();
    render();
}

function flipContextItemHorizontal() {
    const it = state.items.find(x => x.id === contextItemId);
    if (!canFlipItem(it)) return;

    pushHistory();
    it.flipX = !it.flipX;
    state.selectedId = it.id;
    closeContextMenu();
    render();
}

function deleteContextItem() {
    if (!contextItemId) return;
    pushHistory();
    state.items = state.items.filter(x => x.id !== contextItemId);
    state.selectedId = null;
    closeContextMenu();
    render();
}

function addRoomDimensionLine(group, x1, y1, x2, y2, text, options = {}) {
    const { vertical = false, sub = false } = options;
    group.appendChild(addSvg('line', { x1, y1, x2, y2, class: 'room-dimension-line' }));

    const tick = 90;
    if (vertical) {
        group.appendChild(addSvg('line', { x1: x1 - tick / 2, y1, x2: x1 + tick / 2, y2: y1, class: 'room-dimension-tick' }));
        group.appendChild(addSvg('line', { x1: x2 - tick / 2, y1: y2, x2: x2 + tick / 2, y2: y2, class: 'room-dimension-tick' }));
        const tx = x1 - 105;
        const ty = (y1 + y2) / 2;
        const label = addSvg('text', { x: tx, y: ty, class: sub ? 'room-dimension-sub' : 'room-dimension-text', transform: `rotate(-90 ${tx} ${ty})` });
        label.textContent = `${Math.round(text)} mm`;
        group.appendChild(label);
    } else {
        group.appendChild(addSvg('line', { x1, y1: y1 - tick / 2, x2: x1, y2: y1 + tick / 2, class: 'room-dimension-tick' }));
        group.appendChild(addSvg('line', { x1: x2, y1: y2 - tick / 2, x2: x2, y2: y2 + tick / 2, class: 'room-dimension-tick' }));
        const label = addSvg('text', { x: (x1 + x2) / 2, y: y1 - 105, class: sub ? 'room-dimension-sub' : 'room-dimension-text' });
        label.textContent = `${Math.round(text)} mm`;
        group.appendChild(label);
    }
}

function drawRoomDimensions(room, margin) {
    const w = state.room.w;
    const h = state.room.h;
    const topY = margin - 300;
    const leftX = margin - 300;

    addRoomDimensionLine(room, margin, topY, margin + w, topY, w);
    addRoomDimensionLine(room, leftX, margin, leftX, margin + h, h, { vertical: true });

    if (state.room.type === 'lshape') {
        const nx = getNotchX();
        const ny = getNotchY();
        const corner = state.room.lshapeCorner || 'tr';
        const cutoutW = (corner === 'tr' || corner === 'br') ? w - nx : nx;
        const cutoutH = (corner === 'tr' || corner === 'tl') ? ny : h - ny;
        const x1 = corner === 'tr' || corner === 'br' ? margin + nx : margin;
        const x2 = corner === 'tr' || corner === 'br' ? margin + w : margin + nx;
        const subY = margin + ny + (corner === 'br' || corner === 'bl' ? 180 : -150);
        addRoomDimensionLine(room, x1, subY, x2, subY, cutoutW, { sub: true });

        const subX = margin + nx + (corner === 'tr' || corner === 'br' ? 175 : -175);
        const y1 = corner === 'tr' || corner === 'tl' ? margin : margin + ny;
        const y2 = corner === 'tr' || corner === 'tl' ? margin + ny : margin + h;
        addRoomDimensionLine(room, subX, y1, subX, y2, cutoutH, { vertical: true, sub: true });
    }
}

function addRoomResizeHandles(room, margin) {
    const w = state.room.w;
    const h = state.room.h;
    const r = 48;

    const handles = [
        { axis: 'w', cx: margin + w, cy: margin + h / 2 },
        { axis: 'h', cx: margin + w / 2, cy: margin + h },
        { axis: 'both', cx: margin + w, cy: margin + h }
    ];

    handles.forEach(info => {
        const handle = addSvg('circle', {
            cx: info.cx,
            cy: info.cy,
            r,
            class: 'room-resize-handle',
            'data-axis': info.axis
        });
        handle.addEventListener('pointerdown', e => startRoomResize(e, info.axis));
        room.appendChild(handle);
    });
}

function keepItemsInsideAfterRoomResize() {
    state.items.forEach(it => {
        if (it.type === 'entrance') {
            snapEntranceToWall(it, it.wallKey || it.wallSide);
            return;
        }

        let bounds = getRenderedBounds(it);
        if (bounds.x + bounds.w > state.room.w) it.x -= (bounds.x + bounds.w - state.room.w);
        if (bounds.y + bounds.h > state.room.h) it.y -= (bounds.y + bounds.h - state.room.h);
        bounds = getRenderedBounds(it);
        if (bounds.x < 0) it.x -= bounds.x;
        if (bounds.y < 0) it.y -= bounds.y;

        it.x = Math.round(it.x / 10) * 10;
        it.y = Math.round(it.y / 10) * 10;

        // ㄱ자 잘린 영역에 들어간 객체는 아래쪽 영역으로 우선 이동한다.
        if (state.room.type === 'lshape' && !fitsInRoom(it, it.x, it.y)) {
            const b = getRenderedBounds(it);
            const ny = getNotchY();
            const candidateY = Math.max(it.y, ny - (b.y - it.y));
            if (fitsInRoom(it, it.x, candidateY)) it.y = Math.round(candidateY / 10) * 10;
            else {
                const nx = getNotchX();
                const candidateX = Math.max(0, nx - b.w - (b.x - it.x));
                if (fitsInRoom(it, candidateX, it.y)) it.x = Math.round(candidateX / 10) * 10;
            }
        }
    });
}

function applyRoomSize(width, height) {
    state.room.w = Math.max(1500, Math.round(width / 10) * 10);
    state.room.h = Math.max(1500, Math.round(height / 10) * 10);
    normalizeLShapeRoom();
    keepItemsInsideAfterRoomResize();
}

function startRoomResize(e, axis) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pushHistory();
    roomResizeDrag = { axis };
    document.addEventListener('pointermove', onRoomResize);
    document.addEventListener('pointerup', endRoomResize, { once: true });
}

function onRoomResize(e) {
    if (!roomResizeDrag) return;
    const pt = svgPoint(e);
    let w = state.room.w;
    let h = state.room.h;
    if (roomResizeDrag.axis === 'w' || roomResizeDrag.axis === 'both') w = pt.x;
    if (roomResizeDrag.axis === 'h' || roomResizeDrag.axis === 'both') h = pt.y;
    applyRoomSize(w, h);
    render();
}

function endRoomResize() {
    roomResizeDrag = null;
    document.removeEventListener('pointermove', onRoomResize);
}

function rotateRoom(direction = 'right') {
    pushHistory();
    closeContextMenu();
    closeRoomContextMenu();

    const oldW = state.room.w;
    const oldH = state.room.h;
    const oldNX = state.room.type === 'lshape' ? getNotchX() : null;
    const oldNY = state.room.type === 'lshape' ? getNotchY() : null;
    const clockwise = direction === 'right';

    state.items.forEach(it => {
        const oldCx = it.x + it.w / 2;
        const oldCy = it.y + it.h / 2;
        const newCx = clockwise ? oldH - oldCy : oldCy;
        const newCy = clockwise ? oldCx : oldW - oldCx;

        if (it.type === 'entrance') {
            const oldItemW = it.w;
            const oldItemH = it.h;
            it.w = oldItemH;
            it.h = oldItemW;
            it.x = newCx - it.w / 2;
            it.y = newCy - it.h / 2;
        } else {
            it.x = newCx - it.w / 2;
            it.y = newCy - it.h / 2;
            it.rot = normalizeRotation((it.rot || 0) + (clockwise ? 90 : -90));
            if (isWallFixture(it)) it.wallKey = null;
        }
    });

    state.room.w = oldH;
    state.room.h = oldW;

    if (state.room.type === 'lshape') {
        const corner = state.room.lshapeCorner || 'tr';
        state.room.notchX = Math.round((clockwise ? oldH - oldNY : oldNY) / 10) * 10;
        state.room.notchY = Math.round((clockwise ? oldNX : oldW - oldNX) / 10) * 10;
        const rightMap = { tr:'br', br:'bl', bl:'tl', tl:'tr' };
        const leftMap = { tr:'tl', tl:'bl', bl:'br', br:'tr' };
        state.room.lshapeCorner = (clockwise ? rightMap : leftMap)[corner] || 'tr';
        normalizeLShapeRoom();
    }

    state.items.forEach(it => {
        it.x = Math.round(it.x / 10) * 10;
        it.y = Math.round(it.y / 10) * 10;
    });
    state.items.filter(i => i.type === 'entrance').forEach(i => snapEntranceToWall(i));
    state.items.filter(isWallFixture).forEach(i => snapWallFixture(i, i.wallKey));
    syncInputs();
    render();
}

function flipRoomHorizontal() {
    pushHistory();
    closeContextMenu();
    closeRoomContextMenu();

    const oldW = state.room.w;
    const oldNX = state.room.type === 'lshape' ? getNotchX() : null;

    // 방의 세로 중심축을 기준으로 모든 배치 요소를 좌우 반전한다.
    state.items.forEach(it => {
        const oldCx = it.x + it.w / 2;
        const newCx = oldW - oldCx;
        it.x = newCx - it.w / 2;

        // 일반 가구/구조물의 방향도 거울상에 맞춘다.
        if (it.type !== 'entrance') {
            it.rot = normalizeRotation(-(it.rot || 0));
            if (isWallFixture(it)) it.wallKey = null;
        }

        // 방 전체를 거울 반전할 때 비정형 컨트롤의 좌우 형태도 함께 반전한다.
        if (canFlipItem(it)) it.flipX = !it.flipX;
    });

    // ㄱ자형은 잘려 있는 코너와 꺾임 X 좌표도 함께 반전한다.
    if (state.room.type === 'lshape') {
        state.room.notchX = Math.round((oldW - oldNX) / 10) * 10;
        const flipMap = { tr:'tl', tl:'tr', br:'bl', bl:'br' };
        state.room.lshapeCorner = flipMap[state.room.lshapeCorner || 'tr'] || 'tl';
        normalizeLShapeRoom();
    }

    state.items.forEach(it => {
        it.x = Math.round(it.x / 10) * 10;
        it.y = Math.round(it.y / 10) * 10;
    });

    // 현관은 반전된 실제 외벽 구간을 기준으로 다시 스냅한다.
    state.items.filter(i => i.type === 'entrance').forEach(i => snapEntranceToWall(i));
    state.items.filter(isWallFixture).forEach(i => snapWallFixture(i, i.wallKey));

    syncInputs();
    render();
}

function openRoomContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    roomContextOpen = true;
    state.selectedId = null;
    renderProperties();

    const menu = $('#roomContextMenu');
    if (!menu) return;
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    const pad = 8;
    const left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - pad);
    const top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - pad);
    menu.style.left = Math.max(pad, left) + 'px';
    menu.style.top = Math.max(pad, top) + 'px';
}

function closeRoomContextMenu() {
    const menu = $('#roomContextMenu');
    if (!menu) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    roomContextOpen = false;
}


function rangesOverlap(a1, a2, b1, b2) {
    return Math.max(a1, b1) <= Math.min(a2, b2);
}

function nearestMeasurementCandidates(it) {
    const b = getRenderedBounds(it);
    const result = { left: null, right: null, top: null, bottom: null };

    function consider(side, gap, target, overlapStart, overlapEnd, targetKind) {
        if (!Number.isFinite(gap) || gap < 0) return;
        const current = result[side];
        if (!current || gap < current.gap) {
            result[side] = { gap, target, overlapStart, overlapEnd, targetKind };
        }
    }

    // 실제 방 외벽. ㄱ자형에서는 꺾인 2개 외벽까지 모두 포함한다.
    roomBoundarySegments().forEach(seg => {
        if (seg.orientation === 'v') {
            const sy1 = Math.min(seg.y1, seg.y2);
            const sy2 = Math.max(seg.y1, seg.y2);
            if (!rangesOverlap(b.y, b.y + b.h, sy1, sy2)) return;
            const ov1 = Math.max(b.y, sy1);
            const ov2 = Math.min(b.y + b.h, sy2);
            if (seg.x1 <= b.x) consider('left', b.x - seg.x1, seg.x1, ov1, ov2, 'wall');
            if (seg.x1 >= b.x + b.w) consider('right', seg.x1 - (b.x + b.w), seg.x1, ov1, ov2, 'wall');
        } else {
            const sx1 = Math.min(seg.x1, seg.x2);
            const sx2 = Math.max(seg.x1, seg.x2);
            if (!rangesOverlap(b.x, b.x + b.w, sx1, sx2)) return;
            const ov1 = Math.max(b.x, sx1);
            const ov2 = Math.min(b.x + b.w, sx2);
            if (seg.y1 <= b.y) consider('top', b.y - seg.y1, seg.y1, ov1, ov2, 'wall');
            if (seg.y1 >= b.y + b.h) consider('bottom', seg.y1 - (b.y + b.h), seg.y1, ov1, ov2, 'wall');
        }
    });

    // 다른 컨트롤의 실제 회전 후 bounding box.
    state.items.forEach(other => {
        if (other.id === it.id) return;
        const o = getRenderedBounds(other);

        if (rangesOverlap(b.y, b.y + b.h, o.y, o.y + o.h)) {
            const ov1 = Math.max(b.y, o.y);
            const ov2 = Math.min(b.y + b.h, o.y + o.h);
            if (o.x + o.w <= b.x) consider('left', b.x - (o.x + o.w), o.x + o.w, ov1, ov2, 'item');
            if (o.x >= b.x + b.w) consider('right', o.x - (b.x + b.w), o.x, ov1, ov2, 'item');
        }

        if (rangesOverlap(b.x, b.x + b.w, o.x, o.x + o.w)) {
            const ov1 = Math.max(b.x, o.x);
            const ov2 = Math.min(b.x + b.w, o.x + o.w);
            if (o.y + o.h <= b.y) consider('top', b.y - (o.y + o.h), o.y + o.h, ov1, ov2, 'item');
            if (o.y >= b.y + b.h) consider('bottom', o.y - (b.y + b.h), o.y, ov1, ov2, 'item');
        }
    });

    return { bounds: b, distances: result };
}

function appendGuideLabel(group, x, y, text) {
    const width = Math.max(260, text.length * 62);
    group.appendChild(addSvg('rect', {
        x: x - width / 2,
        y: y - 70,
        width,
        height: 140,
        rx: 45,
        class: 'measure-guide-label-bg'
    }));
    const t = addSvg('text', {
        x, y,
        class: 'measure-guide-label'
    });
    t.textContent = text;
    group.appendChild(t);
}

function appendMeasurementGuidesForItem(layer, margin, it, groupClass = 'measurement-guides') {
    if (!it || it.type === 'window') return;

    const { bounds: b, distances } = nearestMeasurementCandidates(it);
    const group = addSvg('g', { class: groupClass, 'pointer-events': 'none' });
    const tick = 60;

    Object.entries(distances).forEach(([side, info]) => {
        if (!info) return;
        const gap = Math.round(info.gap);
        let x1, y1, x2, y2, lx, ly;

        if (side === 'left' || side === 'right') {
            const y = margin + (info.overlapStart + info.overlapEnd) / 2;
            x1 = margin + (side === 'left' ? info.target : b.x + b.w);
            x2 = margin + (side === 'left' ? b.x : info.target);
            y1 = y2 = y;
            lx = (x1 + x2) / 2;
            ly = y - 90;

            group.appendChild(addSvg('line', { x1, y1: y - tick, x2: x1, y2: y + tick, class: 'measure-guide-tick' }));
            group.appendChild(addSvg('line', { x1: x2, y1: y - tick, x2, y2: y + tick, class: 'measure-guide-tick' }));
        } else {
            const x = margin + (info.overlapStart + info.overlapEnd) / 2;
            y1 = margin + (side === 'top' ? info.target : b.y + b.h);
            y2 = margin + (side === 'top' ? b.y : info.target);
            x1 = x2 = x;
            lx = x + 115;
            ly = (y1 + y2) / 2;

            group.appendChild(addSvg('line', { x1: x - tick, y1, x2: x + tick, y2: y1, class: 'measure-guide-tick' }));
            group.appendChild(addSvg('line', { x1: x - tick, y1: y2, x2: x + tick, y2, class: 'measure-guide-tick' }));
        }

        group.appendChild(addSvg('line', { x1, y1, x2, y2, class: 'measure-guide-line' }));
        appendGuideLabel(group, lx, ly, `${gap} mm`);
    });

    layer.appendChild(group);
}

function drawMeasurementGuides(layer, margin) {
    const selectedToggle = $('#guideToggle');
    const allToggle = $('#allGuideToggle');

    if (allToggle?.checked) {
        state.items
            .filter(it => it.type !== 'window')
            .forEach(it => appendMeasurementGuidesForItem(layer, margin, it, 'measurement-guides all-measurement-guides'));
        return;
    }

    if (!selectedToggle?.checked) return;
    const it = selected();
    if (!it || it.type === 'window') return;
    appendMeasurementGuidesForItem(layer, margin, it);
}

function renderSvg() {
    const room = $('#roomLayer');
    const layer = $('#itemLayer');

    room.innerHTML = '';
    layer.innerHTML = '';

    const margin = CANVAS_MARGIN;

    // 방 전체 바닥: 직사각형 또는 ㄱ자형 외곽
    const viewW = state.room.w + CANVAS_MARGIN * 2;
    const viewH = state.room.h + CANVAS_MARGIN * 2;
    $('#floorSvg').setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
    $('#gridBg').setAttribute('width', viewW);
    $('#gridBg').setAttribute('height', viewH);

    const floor = document.createElementNS(NS, 'path');
    floor.setAttribute('d', roomFloorPath(margin));
    floor.setAttribute('class', 'floor-room');
    floor.addEventListener('contextmenu', openRoomContextMenu);
    room.appendChild(floor);

    // ㄱ자형은 꺾이는 모서리를 직접 드래그해서 크기를 바꿀 수 있다.
    if (state.room.type === 'lshape') {
        const handle = addSvg('circle', {
            cx: margin + getNotchX(),
            cy: margin + getNotchY(),
            r: 55,
            class: 'notch-handle',
            'data-role': 'notch-handle'
        });
        handle.addEventListener('pointerdown', startNotchDrag);
        room.appendChild(handle);
    }

    // 외곽 치수선과 방 전체 크기 조절 핸들
    drawRoomDimensions(room, margin);
    addRoomResizeHandles(room, margin);

    state.items.filter(isWallFixture).forEach(i => snapWallFixture(i, i.wallKey));

    state.items.forEach(it => {
        const g = document.createElementNS(NS, 'g');
        g.setAttribute(
            'class',
            'item' + (it.id === state.selectedId ? ' selected' : '')
        );
        g.dataset.id = it.id;

        const itemX = margin + it.x;
        const itemY = margin + it.y;
        const cx = itemX + it.w / 2;
        const cy = itemY + it.h / 2;

        // 현재 회전 기능 그대로 사용
        g.setAttribute(
            'transform',
            `rotate(${it.type === 'entrance' ? 0 : it.rot} ${cx} ${cy})`
        );

        /*
         * 투명 hitbox
         * - 클릭/드래그 영역
         * - 충돌 표시용 .body
         * - 실제 그림은 drawItemDetail()에서 생성
         */
        const hitbox = document.createElementNS(NS, 'rect');
        hitbox.setAttribute('x', itemX);
        hitbox.setAttribute('y', itemY);
        hitbox.setAttribute('width', it.w);
        hitbox.setAttribute('height', it.h);
        hitbox.setAttribute('rx', Math.min(40, it.w / 12));
        hitbox.setAttribute('fill', 'transparent');
        hitbox.setAttribute('stroke', 'transparent');
        hitbox.setAttribute('stroke-width', '18');
        hitbox.setAttribute('class', 'body');
        g.appendChild(hitbox);

        // 욕실/싱크대/침대/책상 등 디테일 SVG 그림.
        // 비정형 컨트롤은 중심축 기준으로 좌우 반전할 수 있다.
        const visual = document.createElementNS(NS, 'g');
        if (it.flipX && it.type !== 'entrance') {
            visual.setAttribute('transform', `translate(${2 * cx} 0) scale(-1 1)`);
        }
        g.appendChild(visual);
        drawItemDetail(
            visual,
            it,
            itemX,
            itemY,
            it.w,
            it.h
        );

        // 선택 테두리
        const sel = document.createElementNS(NS, 'rect');
        sel.setAttribute('x', itemX);
        sel.setAttribute('y', itemY);
        sel.setAttribute('width', it.w);
        sel.setAttribute('height', it.h);
        sel.setAttribute('rx', Math.min(40, it.w / 12));
        sel.setAttribute('class', 'select-outline');
        g.appendChild(sel);

        // 선택된 객체의 네 모서리 리사이즈 핸들
        addResizeHandles(g, it, itemX, itemY);

        // 벽처럼 폭이 매우 얇은 객체에는 중앙 라벨을 표시하지 않는다.
        if (it.type !== 'wall') {
            // 컨트롤이 회전하더라도 라벨은 항상 화면 정면(0°)을 유지한다.
            // 부모 <g>에 적용된 회전을 같은 중심점에서 역회전하여 상쇄한다.
            const itemRotation = it.type === 'entrance' ? 0 : normalizeRotation(it.rot || 0);
            const labelTransform = itemRotation
                ? `rotate(${-itemRotation} ${cx} ${cy})`
                : null;

            const t = document.createElementNS(NS, 'text');
            t.setAttribute('x', cx);
            t.setAttribute('y', cy - 25);
            t.setAttribute('class', 'item-label');
            if (labelTransform) t.setAttribute('transform', labelTransform);
            t.textContent = it.name;
            g.appendChild(t);

            const s = document.createElementNS(NS, 'text');
            s.setAttribute('x', cx);
            s.setAttribute('y', cy + 95);
            s.setAttribute('class', 'item-size');
            if (labelTransform) s.setAttribute('transform', labelTransform);
            const renderedSize = getRenderedSize(it);
            s.textContent = `${Math.round(renderedSize.w)} x ${Math.round(renderedSize.h)}`;
            g.appendChild(s);
        }

        g.addEventListener(
            'pointerdown',
            e => startDrag(e, it.id)
        );

        g.addEventListener('click', e => {
            e.stopPropagation();
            closeContextMenu();
            state.selectedId = it.id;
            render();
        });

        g.addEventListener('contextmenu', e => openContextMenu(e, it.id));

        layer.appendChild(g);
    });

    // 선택된 컨트롤에서 가장 가까운 외벽/다른 컨트롤까지의 보조 치수.
    // render() 때마다 다시 계산하므로 이동/리사이즈/회전에 즉시 따라간다.
    drawMeasurementGuides(layer, margin);

    checkCollisions();
}

function checkCollisions() {
    if (!$('#collisionToggle').checked) return;
    const furn = state.items.filter(i => i.kind === 'furniture');

    for (let i = 0; i < furn.length; i++) {
        for (let j = i + 1; j < furn.length; j++) {
            if (overlap(furn[i], furn[j])) {
                document.querySelector(`[data-id="${furn[i].id}"] .body`)?.classList.add('collision');
                document.querySelector(`[data-id="${furn[j].id}"] .body`)?.classList.add('collision');
            }
        }
    }
}

function overlap(a, b) {
    const A = getRenderedBounds(a);
    const B = getRenderedBounds(b);
    return A.x < B.x + B.w &&
           A.x + A.w > B.x &&
           A.y < B.y + B.h &&
           A.y + A.h > B.y;
}

function startDrag(e, id) {
    if (e.button !== 0 || e.target.classList.contains('resize-handle')) return;
    e.preventDefault();
    closeContextMenu();
    const it = state.items.find(x => x.id === id);
    state.selectedId = id;
    pushHistory();
    const pt = svgPoint(e);
    drag = { id, dx: pt.x - it.x, dy: pt.y - it.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onDrag);
    document.addEventListener('pointerup', endDrag, { once: true });
}

function onDrag(e) {
    if (!drag) return;

    const it = state.items.find(x => x.id === drag.id);
    const pt = svgPoint(e);

    let nx = Math.round((pt.x - drag.dx) / 10) * 10;
    let ny = Math.round((pt.y - drag.dy) / 10) * 10;

    if (it.type === 'entrance') {
        it.x = nx;
        it.y = ny;
        snapEntranceToWall(it);
        render();
        return;
    }

    if (isWallFixture(it)) {
        it.x = nx;
        it.y = ny;
        it.h = FIXTURE_THICKNESS;
        it.wallKey = null;
        snapWallFixture(it);
        render();
        return;
    }

    // 회전된 실제 bounding box가 방 바깥으로 나가지 않게 보정한다.
    const testBounds = getRenderedBounds(it, nx, ny);
    if (testBounds.x < 0) nx -= testBounds.x;
    if (testBounds.y < 0) ny -= testBounds.y;

    let adjusted = getRenderedBounds(it, nx, ny);
    if (adjusted.x + adjusted.w > state.room.w) {
        nx -= adjusted.x + adjusted.w - state.room.w;
    }
    if (adjusted.y + adjusted.h > state.room.h) {
        ny -= adjusted.y + adjusted.h - state.room.h;
    }

    nx = Math.round(nx / 10) * 10;
    ny = Math.round(ny / 10) * 10;

    if (fitsInRoom(it, nx, ny)) {
        it.x = nx;
        it.y = ny;
    }

    render();
}
function endDrag() { drag = null; document.removeEventListener('pointermove', onDrag) }
function svgPoint(e) { const svg = $('#floorSvg'), p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const q = p.matrixTransform(svg.getScreenCTM().inverse()); return { x: q.x - CANVAS_MARGIN, y: q.y - CANVAS_MARGIN } }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }
function selected() { return state.items.find(x => x.id === state.selectedId) }
function renderProperties() {
    const it = selected();
    const controls = ['#posX', '#posY', '#itemW', '#itemH', '#deleteBtn'];
    controls.forEach(s => $(s).disabled = !it);

    if (!it) {
        $('#selectedName').textContent = '선택 없음';
        $('#selectedSize').textContent = '';
        return;
    }

    const size = getRenderedSize(it);
    const rot = normalizeRotation(it.rot || 0);

    $('#selectedName').textContent = it.name;
    $('#selectedSize').textContent = `${Math.round(size.w)} x ${Math.round(size.h)} mm`;
    $('#posX').value = Math.round(getRenderedBounds(it).x);
    $('#posY').value = Math.round(getRenderedBounds(it).y);

    // 사용자가 보는 가로/세로 역시 회전된 화면 기준으로 표시한다.
    if (isFixedThicknessControl(it)) {
        $('#itemW').value = Math.round(it.w);
        $('#itemH').value = FIXTURE_THICKNESS;
        $('#itemH').disabled = true;
        $('#selectedSize').textContent = `길이 ${Math.round(it.w)} mm · 두께 고정`;
    } else {
        $('#itemW').value = Math.round(size.w);
        $('#itemH').value = Math.round(size.h);
        $('#itemH').disabled = false;
    }

    $$('[data-rot]').forEach(b =>
        b.classList.toggle('active', +b.dataset.rot === (it.type === 'entrance' ? entranceRotationFromSide(it.wallSide || 'bottom') : rot))
    );
}
function renderPlaced() { const list = $('#placedList'); list.innerHTML = ''; const arr = state.items.filter(i => i.kind === 'furniture'); arr.forEach(i => { const li = document.createElement('li'); li.textContent = `${i.name} (${i.w} x ${i.h})`; list.appendChild(li) }); $('#furnitureCount').textContent = `총 가구 ${arr.length}개` }
const productCategoryLabels = {
    bed: '침대',
    desk: '책상',
    chair: '의자',
    storage: '수납장',
    sofa: '소파',
    table: '테이블',
    tv: 'TV장',
    fridge: '냉장고',
    closet: '옷장'
};

function placedProductCategories() {
    return [...new Set(
        state.items
            .filter(item => item.kind === 'furniture')
            .map(item => item.type)
    )];
}

function activeProductCat() {
    const active = $('#productTabs .active')?.dataset.category;
    const placed = placedProductCategories();

    if (active === 'all' && placed.length > 1) return 'all';
    if (active && placed.includes(active)) return active;
    return placed[0] || null;
}

function renderProductTabs() {
    const tabs = $('#productTabs');
    if (!tabs) return;

    const placed = placedProductCategories();
    const previous = activeProductCat();
    tabs.innerHTML = '';

    placed.forEach(category => {
        const button = document.createElement('button');
        button.dataset.category = category;
        button.textContent = productCategoryLabels[category] || category;
        button.onclick = () => {
            $$('#productTabs button').forEach(x => x.classList.remove('active'));
            button.classList.add('active');
            renderProducts(category);
        };
        tabs.appendChild(button);
    });

    if (placed.length > 1) {
        const allButton = document.createElement('button');
        allButton.dataset.category = 'all';
        allButton.textContent = '전체 보기 ›';
        allButton.onclick = () => {
            $$('#productTabs button').forEach(x => x.classList.remove('active'));
            allButton.classList.add('active');
            renderProducts('all');
        };
        tabs.appendChild(allButton);
    }

    const nextActive = previous === 'all' && placed.length > 1
        ? 'all'
        : (placed.includes(previous) ? previous : placed[0]);

    if (nextActive) {
        tabs.querySelector(`[data-category="${nextActive}"]`)?.classList.add('active');
    }
}

// app.js가 DB 종류를 직접 알지 않도록 이 함수 하나에서 접속 대상을 선택한다.
async function loadProducts(category) {
    if (!category || category === 'all') return [];

    if (productCache.has(category)) {
        return productCache.get(category);
    }

    // 같은 카테고리를 동시에 여러 번 요청하는 것을 방지한다.
    if (productLoadPromises.has(category)) {
        return await productLoadPromises.get(category);
    }

    const productApi = USE_LOCAL_DB ? localProductApi : d1ProductApi;
    const loadPromise = productApi.getProducts(category)
        .then(items => {
            const products = Array.isArray(items) ? items : [];
            productCache.set(category, products);
            return products;
        })
        .finally(() => productLoadPromises.delete(category));

    productLoadPromises.set(category, loadPromise);
    return await loadPromise;
}

// 상품 카드의 "상품 보러가기"는 클릭 통계를 기록한 뒤 DB의 제휴 URL을 연다.
function onProductViewClick(product) {
    if (!product?.affiliate_url) return;

    // 통계 저장은 비동기로 보내고, 제휴 링크 이동은 기다리지 않는다.
    recordProductClick(product);
    window.open(product.affiliate_url, '_blank', 'noopener,noreferrer');
}

let productRenderToken = 0;

function productSizeLabel(product) {
    const options = Array.isArray(product.options) ? product.options : [];
    if (!options.length) return '';
    if (options.length === 1) {
        const o = options[0];
        return `${o.width} x ${o.depth} mm`;
    }
    return `${options.length}개 사이즈 옵션`;
}

function createProductCard(product) {
    const c = document.createElement('div');
    c.className = 'product-card';

    const imageBox = document.createElement('div');
    imageBox.className = 'product-img';
    if (product.image_url) {
        const img = document.createElement('img');
        img.src = product.image_url;
        img.alt = product.name || '상품 이미지';
        img.loading = 'lazy';
        img.onerror = () => {
            imageBox.innerHTML = '';
            imageBox.textContent = '이미지 없음';
        };
        imageBox.appendChild(img);
    } else {
        imageBox.textContent = '이미지 없음';
    }

    const title = document.createElement('h4');
    title.textContent = product.name || '상품';
    title.title = product.name || '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = productSizeLabel(product);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const button = document.createElement('button');
    button.className = 'product-view';
    button.textContent = '상품 보러가기 ›';
    button.onclick = () => onProductViewClick(product);
    actions.appendChild(button);

    c.append(imageBox, title, meta, actions);
    return c;
}

async function renderProducts(cat = null) {
    const row = $('#productRow');
    if (!row) return;

    const token = ++productRenderToken;
    row.innerHTML = '';

    const placed = placedProductCategories();
    if (!placed.length || !cat) return;

    try {
        let items = [];

        if (cat === 'all') {
            // 배치된 카테고리만 합친다. 카테고리별 데이터는 최초 조회 후 Map 캐시에 보관된다.
            const groups = await Promise.all(placed.map(category => loadProducts(category)));
            items = groups.flat();
        } else {
            if (!placed.includes(cat)) return;
            items = await loadProducts(cat);
        }

        if (token !== productRenderToken) return;

        items.forEach(product => row.appendChild(createProductCard(product)));
    } catch (error) {
        console.error('상품 목록 조회 실패:', error);
        if (token === productRenderToken) {
            row.innerHTML = '<div class="product-load-error">상품 목록을 불러오지 못했습니다.</div>';
        }
    }
}

$$('[data-tab]').forEach(b => b.onclick = () => { $$('[data-tab]').forEach(x => x.classList.remove('active')); b.classList.add('active'); $('#structureTab').classList.toggle('hidden', b.dataset.tab !== 'structure'); $('#furnitureTab').classList.toggle('hidden', b.dataset.tab !== 'furniture') });
$('#floorSvg').addEventListener('click', () => { closeContextMenu(); closeRoomContextMenu(); state.selectedId = null; render() });
['posX', 'posY', 'itemW', 'itemH'].forEach(id => $('#' + id).addEventListener('change', e => {
    const it = selected();
    if (!it) return;
    pushHistory();

    const value = Math.max(0, +e.target.value || 0);
    const rot = normalizeRotation(it.rot || 0);
    const bounds = getRenderedBounds(it);

    if (id === 'posX') {
        // 입력값은 화면에 보이는 bounding box의 X 좌표
        it.x += value - bounds.x;
    }
    if (id === 'posY') {
        // 입력값은 화면에 보이는 bounding box의 Y 좌표
        it.y += value - bounds.y;
    }
    if (id === 'itemW') {
        if (isFixedThicknessControl(it)) {
            it.w = Math.max(300, value);
            it.h = FIXTURE_THICKNESS;
            if (isWallFixture(it)) snapWallFixture(it, it.wallKey);
        } else if (rot === 90 || rot === 270) it.h = value;
        else it.w = value;
    }
    if (id === 'itemH' && !isFixedThicknessControl(it)) {
        if (rot === 90 || rot === 270) it.w = value;
        else it.h = value;
    }

    render();
}));
$$('[data-align]').forEach(b => b.onclick = () => {
    const it = selected();
    if (!it) return;
    pushHistory();

    const bounds = getRenderedBounds(it);

    switch (b.dataset.align) {
        case 'left':
            it.x -= bounds.x;
            break;

        case 'right':
            it.x += state.room.w - (bounds.x + bounds.w);
            break;

        case 'centerX':
            it.x += (state.room.w - bounds.w) / 2 - bounds.x;
            break;

        case 'top':
            it.y -= bounds.y;
            break;

        case 'bottom':
            it.y += state.room.h - (bounds.y + bounds.h);
            break;

        case 'centerY':
            it.y += (state.room.h - bounds.h) / 2 - bounds.y;
            break;
    }

    it.x = Math.round(it.x / 10) * 10;
    it.y = Math.round(it.y / 10) * 10;
    render();
});
$$('[data-rot]').forEach(b => b.onclick = () => { const it = selected(); if (!it) return; pushHistory(); if (it.type === 'entrance') snapEntranceToWall(it, entranceSideFromRotation(+b.dataset.rot)); else if (isWallFixture(it)) rotateWallFixture(it, +b.dataset.rot); else it.rot = +b.dataset.rot; render() });
function deleteSelectedItem() {
    if (!selected()) return;
    pushHistory();
    state.items = state.items.filter(x => x.id !== state.selectedId);
    state.selectedId = null;
    render();
}

$('#deleteBtn').onclick = deleteSelectedItem;

document.addEventListener('keydown', e => {
    if (e.key !== 'Delete') return;
    const active = document.activeElement;
    const isTyping = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable
    );
    if (isTyping || !selected()) return;
    e.preventDefault();
    deleteSelectedItem();
});
function updateRoomSizeFromInputs(source = 'top') {
    pushHistory();
    const wInput = source === 'detail' ? $('#detailRoomW') : $('#roomW');
    const hInput = source === 'detail' ? $('#detailRoomH') : $('#roomH');
    applyRoomSize(+wInput.value || state.room.w, +hInput.value || state.room.h);
    render();
}
$('#roomW').onchange = () => updateRoomSizeFromInputs('top');
$('#roomH').onchange = () => updateRoomSizeFromInputs('top');
$('#detailRoomW')?.addEventListener('change', () => updateRoomSizeFromInputs('detail'));
$('#detailRoomH')?.addEventListener('change', () => updateRoomSizeFromInputs('detail'));

function updateNotchFromInputs(source = 'top') {
    if (state.room.type !== 'lshape') return;
    pushHistory();
    const xInput = source === 'detail' ? $('#detailNotchX') : $('#notchX');
    const yInput = source === 'detail' ? $('#detailNotchY') : $('#notchY');
    state.room.notchX = clamp(Math.round((+xInput.value || getNotchX()) / 10) * 10, MIN_NOTCH_SIZE, state.room.w - MIN_NOTCH_SIZE);
    state.room.notchY = clamp(Math.round((+yInput.value || getNotchY()) / 10) * 10, MIN_NOTCH_SIZE, state.room.h - MIN_NOTCH_SIZE);
    keepItemsInsideAfterRoomResize();
    render();
}
$('#notchX')?.addEventListener('change', () => updateNotchFromInputs('top'));
$('#notchY')?.addEventListener('change', () => updateNotchFromInputs('top'));
$('#detailNotchX')?.addEventListener('change', () => updateNotchFromInputs('detail'));
$('#detailNotchY')?.addEventListener('change', () => updateNotchFromInputs('detail'));

function startNotchDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pushHistory();
    notchDrag = true;
    document.addEventListener('pointermove', onNotchDrag);
    document.addEventListener('pointerup', endNotchDrag, { once:true });
}
function onNotchDrag(e) {
    if (!notchDrag || state.room.type !== 'lshape') return;
    const pt = svgPoint(e);
    state.room.notchX = clamp(Math.round(pt.x / 10) * 10, MIN_NOTCH_SIZE, state.room.w - MIN_NOTCH_SIZE);
    state.room.notchY = clamp(Math.round(pt.y / 10) * 10, MIN_NOTCH_SIZE, state.room.h - MIN_NOTCH_SIZE);
    keepItemsInsideAfterRoomResize();
    render();
}
function endNotchDrag() {
    notchDrag = null;
    document.removeEventListener('pointermove', onNotchDrag);
}

$('#zoomIn').onclick = () => { state.zoom = Math.min(1.5, state.zoom + .1); render() }; $('#zoomOut').onclick = () => { state.zoom = Math.max(.4, state.zoom - .1); render() };
$('#gridToggle').onchange = e => $('#gridBg').style.display = e.target.checked ? 'block' : 'none';
$('#gridSize').onchange = e => { const v = +e.target.value; $('#smallGrid').setAttribute('width', v / 5); $('#smallGrid').setAttribute('height', v / 5); $('#grid').setAttribute('width', v); $('#grid').setAttribute('height', v) };
$('#collisionToggle').onchange = render;
$('#guideToggle')?.addEventListener('change', e => {
    if (e.target.checked) {
        const all = $('#allGuideToggle');
        if (all) all.checked = false;
    }
    render();
});
$('#allGuideToggle')?.addEventListener('change', e => {
    if (e.target.checked) {
        const selectedGuide = $('#guideToggle');
        if (selectedGuide) selectedGuide.checked = false;
    }
    render();
});

$$('[data-action]').forEach(b => b.onclick = () => {
    const a = b.dataset.action;
    if (a === 'new') openTemplateModal();
    if (a === 'undo' && state.history.length) {
        state.future.push(JSON.stringify({ room: state.room, items: state.items, selectedId: state.selectedId }));
        restore(state.history.pop());
    }
    if (a === 'redo' && state.future.length) {
        state.history.push(JSON.stringify({ room: state.room, items: state.items, selectedId: state.selectedId }));
        restore(state.future.pop());
    }
});
$('#drawWallBtn').onclick = () => { pushHistory(); const wall = wallItem(Math.round(state.room.w / 2), Math.round(state.room.h / 3), 120, 2000); state.items.push(wall); state.selectedId = wall.id; render(); };

// 메인 그리드 위에서 마우스 휠 확대/축소
const canvasWrap = document.querySelector('.canvas-wrap');
canvasWrap?.addEventListener('wheel', e => {
    e.preventDefault();
    const step = 0.1;
    state.zoom = e.deltaY < 0
        ? Math.min(1.5, state.zoom + step)
        : Math.max(0.4, state.zoom - step);
    render();
}, { passive: false });

// 새 도면 템플릿 선택 UI
$$('.template-card').forEach(card => {
    card.addEventListener('click', () => {
        selectedTemplate = card.dataset.template;
        $$('.template-card').forEach(x => x.classList.toggle('active', x === card));
        const preset = roomTemplates[selectedTemplate];
        if (preset) {
            $('#templateW').value = preset.w;
            $('#templateH').value = preset.h;
        }
    });
});

$$('[data-template-close]').forEach(btn => btn.addEventListener('click', closeTemplateModal));
$('#createTemplateBtn')?.addEventListener('click', () => createFromTemplate(selectedTemplate, $('#templateW').value, $('#templateH').value));

// 아이템 우클릭 메뉴 동작
$$('[data-context-action]').forEach(btn => {
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.dataset.contextAction;
        if (action === 'rotateLeft') rotateContextItem('left');
        if (action === 'rotateRight') rotateContextItem('right');
        if (action === 'flipHorizontal') flipContextItemHorizontal();
        if (action === 'delete') deleteContextItem();
    });
});


// 방 자체 우클릭 메뉴: 방과 내부 배치를 함께 90도 회전
$$('[data-room-context-action]').forEach(btn => {
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.dataset.roomContextAction;
        if (action === 'rotateLeft') rotateRoom('left');
        if (action === 'rotateRight') rotateRoom('right');
        if (action === 'flipHorizontal') flipRoomHorizontal();
    });
});
document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#itemContextMenu')) closeContextMenu();
    if (!e.target.closest('#roomContextMenu')) closeRoomContextMenu();
});

window.addEventListener('blur', () => { closeContextMenu(); closeRoomContextMenu(); });
window.addEventListener('resize', () => { closeContextMenu(); closeRoomContextMenu(); });

buildTools(); seed(); render(); recordPageVisit();
