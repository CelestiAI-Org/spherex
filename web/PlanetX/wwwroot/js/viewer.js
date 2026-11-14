// DOM observation workspace. Data is supplied by the C# API; this module only renders it.
export function createViewer() {
    const el = id => document.getElementById(id);
    const root = el('viewer'), image = el('observation-image'), viewport = el('frame-container');
    const start = el('time-start'), end = el('time-end');
    let spectrumPoints = [], appearance = 'colour';
    let frames = [], bands = [], detectors = [], target = '', label = '', mode = 'single';
    let low = 0, high = 0, current = 0, bandIndex = 0, source = 'epoch', detectorIndex = -1;
    let timer = null, paused = false, zoom = 1, x = 0, y = 0, drag = null, restoreFocus = null;
    const date = mjd => Number.isFinite(mjd) ? new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10) : 'Unknown date';
    const grayUrl = f => f?.png_url_large || f?.url || f?.png_url || f?.png_url_native;
    const frameUrl = f => appearance === 'colour' ? (f?.png_url_color || grayUrl(f)) : grayUrl(f);
    const dateRange = f => !f ? 'No observations' : date(f.mjd_start) === date(f.mjd_end) ? date(f.mjd_start) : `${date(f.mjd_start)} – ${date(f.mjd_end)}`;
    const waveRange = range => range?.length === 2 && range.every(Number.isFinite) ? `${range[0].toFixed(3)}–${range[1].toFixed(3)} μm` : 'Unavailable';
    const bandRange = b => b ? [b.wavelength_um_min, b.wavelength_um_max] : null;
    function wavelengthColour(wave) {
        const lo = spectrumPoints[0]?.wavelength_um ?? bands[0]?.wavelength_um_min ?? .74;
        const hi = spectrumPoints.at(-1)?.wavelength_um ?? bands.at(-1)?.wavelength_um_max ?? 5;
        const palette = [[121,96,199],[84,143,208],[88,178,180],[165,193,123],[223,181,109],[210,124,102]];
        const t = Math.max(0, Math.min(1, (wave-lo)/(hi-lo || 1))) * (palette.length-1);
        const i = Math.min(palette.length-2, Math.floor(t)), f = t-i;
        return `rgb(${palette[i].map((v,c) => Math.round(v*(1-f)+palette[i+1][c]*f)).join(',')})`;
    }
    const stop = () => { clearInterval(timer); timer = null; };
    function transform() {
        const maxX = viewport.clientWidth * (zoom - 1) / 2, maxY = viewport.clientHeight * (zoom - 1) / 2;
        x = Math.max(-maxX, Math.min(maxX, x)); y = Math.max(-maxY, Math.min(maxY, y));
        image.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    }
    function resetImage() { zoom = 1; x = y = 0; transform(); }
    function showImage(url, caption) {
        el('image-caption').textContent = caption;
        image.alt = `${label}: ${caption}`;
        if (!url) {
            image.hidden = true; image.removeAttribute('src');
            el('image-message').textContent = 'No image available for this selection.';
            el('image-message').hidden = false; return;
        }
        if (image.getAttribute('src') !== url) {
            image.hidden = true;
            el('image-message').textContent = 'Loading image…'; el('image-message').hidden = false;
            image.src = url;
        }
    }
    image.addEventListener('load', () => { image.hidden = false; el('image-message').hidden = true; });
    image.addEventListener('error', () => { image.hidden = true; el('image-message').hidden = false; el('image-message').textContent = 'Image could not load. Choose another observation.'; });
    function renderImage() {
        if (source === 'band') {
            const b = bands[bandIndex];
            showImage(b?.webp_url, `Band ${(b?.band_index ?? bandIndex) + 1}${b?.quality === 'low' ? ' · Low quality' : ''}`);
        } else if (source === 'detector') {
            const d = detectors[detectorIndex];
            showImage(d?.png_url || d?.url, `Detector ${d?.detector ?? detectorIndex + 1}`);
        } else showImage(frameUrl(frames[current]), frames.length ? `Observation ${current + 1} / ${frames.length}` : "No cached observations");
        el('observation-date').textContent = dateRange(frames[current]);
        el('observation-date').removeAttribute('datetime');
        if (Number.isFinite(frames[current]?.mjd_start)) el('observation-date').dateTime = date(frames[current].mjd_start);
        el('observer-options').querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === detectorIndex)));
        el('detector-range').textContent = `Wavelength coverage: ${waveRange(detectors[detectorIndex]?.wavelength_range_um)}`;
        el('image-appearance').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.appearance === appearance)));
        if (source === 'epoch' && appearance === 'colour' && frames[current] && !frames[current].png_url_color)
            el('image-caption').textContent += ' · Colour unavailable; showing grayscale';
        renderSpectrum();
    }
    function syncControls() {
        el('observation-controls').dataset.kind = source;
        el('time-selection').hidden = source !== 'epoch';
        el('band-selection').hidden = source !== 'band';
        el('detector-selection').hidden = source !== 'detector';
        el('display-options').hidden = source !== 'epoch';
        el('image-types').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === source)));
    }
    el('image-types').addEventListener('click', e => {
        const button = e.target.closest('[data-source]'); if (!button) return;
        source = button.dataset.source;
        syncControls(); renderBands(); renderImage(); play();
    });
    el('image-appearance').addEventListener('click', e => {
        const button = e.target.closest('[data-appearance]'); if (!button) return;
        appearance = button.dataset.appearance; renderImage();
    });

    function play() {
        stop();
        const active = mode !== 'single' && source === 'epoch' && frames.length > 1;
        el('pause-play').hidden = !active;
        el('pause-play').textContent = paused ? '▶' : 'Ⅱ';
        el('pause-play').setAttribute('aria-label', paused ? 'Resume playback' : 'Pause playback');
        if (!active || paused || document.hidden || root.hidden) return;
        timer = setInterval(() => {
            current = mode === 'compare' ? (current === low ? high : low) : (current >= high ? low : current + 1);
            renderImage();
        }, 500);
    }
    function renderTimeline() {
        const max = Math.max(0, frames.length - 1);
        start.max = end.max = String(max); start.value = low; end.value = high;
        start.disabled = end.disabled = !frames.length;
        end.hidden = mode === 'single';
        start.setAttribute('aria-label', mode === 'single' ? 'Observation date' : 'Start observation date');
        start.setAttribute('aria-valuetext', date(frames[low]?.mjd_start)); end.setAttribute('aria-valuetext', date(frames[high]?.mjd_start));
        const a = max ? low / max * 100 : 0, b = max ? high / max * 100 : 0;
        el('timeline-fill').style.left = `${mode === 'single' ? 0 : a}%`;
        el('timeline-fill').style.width = `${mode === 'single' ? a : b - a}%`;
        // Keep a coincident thumb accessible from either edge, as well as the keyboard.
        start.style.zIndex = low === max ? '3' : '2'; end.style.zIndex = '2';
        el('time-modes').querySelectorAll('button').forEach(b => {
            b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
            b.disabled = !frames.length || (b.dataset.mode !== 'single' && frames.length < 2);
        });
    }
    function epoch() { source = 'epoch'; current = low; renderTimeline(); renderImage(); play(); }
    el('timeline-track').addEventListener('pointerdown', e => {
        if (e.target === start || e.target === end || !frames.length) return;
        const bounds = el('timeline-track').getBoundingClientRect();
        const index = Math.max(0, Math.min(frames.length - 1, Math.round((e.clientX - bounds.left) / bounds.width * (frames.length - 1))));
        if (mode !== 'single' && Math.abs(index - high) < Math.abs(index - low)) high = index;
        else low = index;
        if (low > high) high = low;
        epoch();
    });
    start.addEventListener('input', () => { low = Number(start.value); if (low > high) high = low; epoch(); });
    end.addEventListener('input', () => { high = Number(end.value); if (high < low) low = high; epoch(); });
    el('time-modes').addEventListener('click', e => {
        const button = e.target.closest('[data-mode]'); if (!button) return;
        mode = button.dataset.mode; paused = false;
        if (mode !== 'single' && low === high) { if (mode === 'timelapse') { low = 0; high = frames.length - 1; } else if (high < frames.length - 1) high++; else low = Math.max(0, low - 1); }
        epoch();
    });
    el('pause-play').addEventListener('click', () => { paused = !paused; play(); });
    function renderBands() {
        const slider = el('band-slider'), band = bands[bandIndex];
        slider.max = Math.max(0, bands.length - 1); slider.value = bandIndex;
        slider.disabled = !bands.length;
        slider.setAttribute('aria-valuetext', band ? `Band ${bandIndex+1}, ${waveRange(bandRange(band))}` : 'No band data');
        el('band-range').textContent = waveRange(bandRange(band));
        el('band-detail').textContent = band ? `Band ${bandIndex+1} / ${bands.length} · Detector ${band.detector}${!band.webp_url ? ' · No image available' : band.quality === 'low' ? ' · Low quality' : ''}` : 'No band data for this target.';
        if (bands.length) {
            // Positions follow discrete band indices; each stop uses its actual wavelength.
            slider.style.setProperty('--band-gradient', `linear-gradient(90deg,${bands.map((b,i)=>`${wavelengthColour(b.wavelength_um)} ${i/Math.max(1,bands.length-1)*100}%`).join(',')})`);
            slider.style.setProperty('--band-colour', wavelengthColour(band.wavelength_um));
        }
    }
    el('band-slider').addEventListener('input', () => {
        bandIndex = Number(el('band-slider').value); renderBands(); renderImage();
    });
    function renderDetectors() {
        const box = el('observer-options'); box.replaceChildren();
        detectors.forEach((d, i) => {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = d.detector ?? i + 1;
            button.title = `Detector ${d.detector ?? i + 1}${d.note ? ': ' + d.note : ''}`;
            button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', 'false');
            button.disabled = !(d.png_url || d.url);
            button.addEventListener('click', () => { detectorIndex = i; source = 'detector'; renderImage(); play(); }); box.append(button);
        });
        if (!detectors.length) box.textContent = 'No detector data';
    }
    function renderSpectrum() {
        const svg = el('spectrum-chart'); svg.replaceChildren();
        const points = spectrumPoints;
        el('spectrum-message').hidden = !!points.length;
        el('spectrum-message').textContent = 'Spectrum unavailable for this target.';
        const comparing = source === 'epoch' && mode === 'compare';
        el('legend-a').hidden = el('legend-b').hidden = !comparing;
        el('spectrum-selection').textContent = source === 'epoch'
            ? `${dateRange(frames[current])}${comparing ? ' · Image '+(current === low ? 'A' : 'B') : ''}`
            : source === 'band' ? `Band ${bandIndex+1}` : `Detector ${detectors[detectorIndex]?.detector ?? '—'}`;
        if (!points.length) return;
        // Keep axes stable across date changes and comparisons.
        const minX = points[0].wavelength_um, maxX = points.at(-1).wavelength_um;
        const minY = Math.min(0, ...points.map(p => p.flux)), maxY = Math.max(...points.map(p => p.flux));
        const px = v => 46 + (v-minX)/(maxX-minX || 1)*302;
        const py = v => 176 - (v-minY)/(maxY-minY || 1)*150;
        const node = (tag, attrs, text) => {
            const n = document.createElementNS('http://www.w3.org/2000/svg',tag);
            Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));
            if(text!==undefined)n.textContent=text; svg.append(n); return n;
        };
        const withinEpoch = (p, index) => Number.isFinite(p.mjd) && frames[index]
            && p.mjd >= frames[index].mjd_start && p.mjd <= frames[index].mjd_end;
        let groups;
        if (source === 'epoch') {
            groups = mode === 'compare'
                ? [{id:'A', points:points.filter(p=>withinEpoch(p,low)), colour:'#94c9de'}, {id:'B', points:points.filter(p=>withinEpoch(p,high)), colour:'#efb778'}]
                : [{id:'epoch', points:points.filter(p=>withinEpoch(p,current)), colour:'#94c9de'}];

        } else {
            const range = source === 'band' ? bandRange(bands[bandIndex]) : detectors[detectorIndex]?.wavelength_range_um;
            if (range?.every(Number.isFinite)) {
                const left = Math.max(46,Math.min(348,px(range[0]))), right = Math.max(46,Math.min(348,px(range[1])));
                node('rect',{x:left,y:20,width:Math.max(1,right-left),height:156,fill:wavelengthColour((range[0]+range[1])/2),opacity:.18,'data-role':'wavelength-highlight'});
            }
            const selected = source === 'band' ? points.filter(p=>range && p.wavelength_um>=range[0] && p.wavelength_um<=range[1] && p.detector===bands[bandIndex]?.detector)
                : points.filter(p=>p.detector===detectors[detectorIndex]?.detector);
            groups = [{id:'selected',points:selected,colour:'#c2e9f5'}];
            points.forEach(p=>node('circle',{cx:px(p.wavelength_um),cy:py(p.flux),r:1.5,fill:'#60748b',opacity:.35,'data-role':'context'}));
        }
        for(let i=0;i<4;i++) {
            const value=minY+(maxY-minY)*i/3, y=py(value);
            node('line',{x1:46,x2:348,y1:y,y2:y,stroke:'#2c3d50','stroke-width':1});
            node('text',{x:40,y:y+4,'text-anchor':'end'},value.toPrecision(2));
        }
        for (const group of groups) {
            if (source === 'epoch') node('polyline',{points:group.points.map(p=>`${px(p.wavelength_um)},${py(p.flux)}`).join(' '),fill:'none',stroke:group.colour,'stroke-width':1.2,'data-series':group.id});
            group.points.forEach(p=>node('circle',{cx:px(p.wavelength_um),cy:py(p.flux),r:2,fill:p.saturated?'#070d19':group.colour,stroke:group.colour,'stroke-width':1,'data-series':group.id,'data-role':'selected'}));
        }
        const empty = groups.filter(g=>!g.points.length);
        el('spectrum-message').hidden = !empty.length;
        el('spectrum-message').textContent = empty.length ? (mode==='compare' && source==='epoch' ? `No spectrum measurements for ${empty.map(g=>g.id).join(' / ')}.` : 'No spectrum measurements in this selection.') : '';
        // The axis, colour guide and tick labels share the same SVG coordinates.
        node('line',{x1:46,x2:348,y1:176,y2:176,stroke:'#52667d','stroke-width':1,'data-role':'wavelength-axis'});
        const defs = node('defs',{});
        const gradient = document.createElementNS(svg.namespaceURI,'linearGradient');
        gradient.id = 'spectrum-wavelength-gradient'; defs.append(gradient);
        for (let i=0;i<=5;i++) {
            const stop = document.createElementNS(svg.namespaceURI,'stop');
            stop.setAttribute('offset',`${i*20}%`); stop.setAttribute('stop-color',wavelengthColour(minX+(maxX-minX)*i/5)); gradient.append(stop);
        }
        node('rect',{x:46,y:183,width:302,height:7,rx:2,fill:'url(#spectrum-wavelength-gradient)','data-role':'wavelength-colour'});
        for (let i=0;i<=4;i++) {
            const value=minX+(maxX-minX)*i/4, x=px(value);
            node('line',{x1:x,x2:x,y1:191,y2:195,stroke:'#8ea3ba','stroke-width':1});
            node('text',{x,y:208,'text-anchor':'middle','data-role':'wavelength-tick'},value.toFixed(2));
        }
        node('text',{x:197,y:225,'text-anchor':'middle'},'Wavelength · μm');
        node('text',{x:46,y:12},'Flux · Jy');
    }
    viewport.addEventListener('wheel', e => { e.preventDefault(); zoom=Math.max(1,Math.min(8,zoom*Math.exp(-e.deltaY*.0015))); transform(); }, {passive:false});
    viewport.addEventListener('pointerdown', e => { if(e.button!==0)return; drag={id:e.pointerId,x:e.clientX,y:e.clientY}; viewport.setPointerCapture(e.pointerId);viewport.classList.add('is-dragging'); });
    viewport.addEventListener('pointermove', e => { if(!drag||drag.id!==e.pointerId)return;x+=e.clientX-drag.x;y+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;transform(); });
    const endDrag=()=>{drag=null;viewport.classList.remove('is-dragging');};
    ['pointerup','pointercancel','lostpointercapture'].forEach(event=>viewport.addEventListener(event,endDrag));
    viewport.addEventListener('keydown', e => {
        if (!['+','=','-','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
        e.preventDefault(); if(e.key==='0')resetImage(); else if(e.key==='+'||e.key==='=')zoom=Math.min(8,zoom*1.2);else if(e.key==='-')zoom=Math.max(1,zoom/1.2);else { x+=e.key==='ArrowRight'?25:e.key==='ArrowLeft'?-25:0; y+=e.key==='ArrowDown'?25:e.key==='ArrowUp'?-25:0; } transform();
    });
    el('reset-image').addEventListener('click',resetImage);
    window.addEventListener('resize', transform);
    document.addEventListener('visibilitychange',play);
    el('share-view').addEventListener('click', async()=>{
        const url=new URL(location.href);url.searchParams.set('target',target||label);url.searchParams.set('frame',current);
        url.searchParams.set('view',source); url.searchParams.set('appearance',appearance);
        url.searchParams.set('mode',mode); url.searchParams.set('from',low); url.searchParams.set('to',high);
        url.searchParams.set('band',bandIndex); url.searchParams.set('detector',detectors[detectorIndex]?.detector ?? '');
        try { await navigator.clipboard.writeText(url.href);el('share-status').textContent='Link copied'; }
        catch { el('share-status').textContent='Copy this link: '+url.href; }
    });
    function close(){stop();root.hidden=true;restoreFocus?.focus();}
    el('back-to-sky').addEventListener('click',close);
    root.addEventListener('keydown', e=>{if(e.key==='Escape')el('back-to-sky').click();});
    return {
        open(name, key, data, extras = {}) {
            stop(); restoreFocus=document.activeElement; label=name;target=key;frames=data?.frames||[];
            bands=extras.bands?.bands||[];detectors=extras.detectors?.detectors||[];
            spectrumPoints = (extras.spectrum?.spectrum || []).filter(p => Number.isFinite(p.wavelength_um) && Number.isFinite(p.flux)).sort((a,b)=>a.wavelength_um-b.wavelength_um);
            mode='single';low=high=current=Math.max(0,frames.length-1);source='epoch';bandIndex=0;paused=false;appearance='colour';
            detectorIndex = Math.max(0,detectors.findIndex(d=>d.png_url || d.url));
            const shared = new URL(location.href).searchParams;
            const index = (key, length, fallback) => { const n=Number(shared.get(key));return shared.has(key) && Number.isInteger(n) && n>=0 && n<length ? n : fallback; };
            current=index('frame',frames.length,current);low=index('from',frames.length,current);high=Math.max(low,index('to',frames.length,high));
            bandIndex=index('band',bands.length,0);
            const sharedDetector=detectors.findIndex(d=>String(d.detector)===shared.get('detector'));
            if(sharedDetector>=0)detectorIndex=sharedDetector;
            if(['epoch','band','detector'].includes(shared.get('view')))source=shared.get('view');
            if(['single','compare','timelapse'].includes(shared.get('mode')) && frames.length>1)mode=shared.get('mode');
            if(shared.get('appearance')==='gray')appearance='gray';
            el('viewer-title').textContent=name;el('target-detail').textContent=data?.fov_arcmin ? `${data.fov_arcmin}′ field of view · SPHEREx`:'SPHEREx observations';
            el('share-status').textContent='';root.hidden=false;resetImage();renderDetectors();renderBands();renderTimeline();syncControls();renderImage();play();
            // Warm the browser cache before the 500 ms blink/timelapse playback starts.
            frames.forEach(frame => { const url = frameUrl(frame); if (url) { const preload = new Image(); preload.src = url; } });
            el('back-to-sky').focus();
        }, close
    };
}
