"""Run with the ASP.NET app on :5189 and SpherexApi__BaseUrl=http://127.0.0.1:5190/.
Uses checked-in science exports as a deterministic upstream. Requires Python Playwright.
"""
import json
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
class Upstream(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, *_): pass
    def do_GET(self):
        parsed = urlsplit(self.path)
        routes = {'/frames':'frames', '/spectrum':'spectrum', '/frames_by_detector':'detectors', '/frames_by_band':'bands'}
        if parsed.path in routes:
            target = parse_qs(parsed.query).get('target', ['barnards-star'])[0]
            path = ROOT / 'static_export' / target / (routes[parsed.path] + '.json')
            if not path.exists(): self.send_error(404); return
            body = path.read_bytes()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
        elif parsed.path.startswith('/static/'):
            self.path = '/static_export/' + parsed.path[len('/static/'):]
            super().do_GET()
        else: self.send_error(404)

upstream = ThreadingHTTPServer(('127.0.0.1',5190), Upstream)
threading.Thread(target=upstream.serve_forever,daemon=True).start()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--disable-webgl'])
    context = browser.new_context(viewport={'width':1440,'height':960}, permissions=['clipboard-read','clipboard-write'], ignore_https_errors=True)
    page = context.new_page(); errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto('http://127.0.0.1:5189/?quality=low&intro=off')
        page.wait_for_load_state('networkidle')
        page.wait_for_function('!!window.spherexScene',timeout=30000)
        page.locator('#target-name').fill("Barnard's Star")
        page.locator('#target-form button[type=submit]').click()
        expect(page.locator('#target-panel')).to_be_hidden()
        expect(page.locator('#menu-toggle')).to_have_attribute('aria-expanded','false')
        expect(page.locator('#viewer')).to_be_visible(timeout=45000)
        expect(page.locator('#observation-image')).to_be_visible(timeout=15000)
        expect(page.locator('#viewer-title')).to_have_text("Barnard's Star")
        assert page.locator('#spectrum-chart circle').count() > 10
        assert page.locator('#observer-options button').count() == 6
        expect(page.locator('#band-selection')).to_be_hidden()
        expect(page.locator('#detector-selection')).to_be_hidden()
        expect(page.locator('#time-start')).to_have_value('2')
        assert '_color.webp' in page.locator('#observation-image').get_attribute('src')
        full_spectrum = json.loads((ROOT/'static_export/barnards-star/spectrum.json').read_text())['spectrum']
        frames = json.loads((ROOT/'static_export/barnards-star/frames.json').read_text())['frames']
        def count_epoch(i): return sum(frames[i]['mjd_start']<=p['mjd']<=frames[i]['mjd_end'] for p in full_spectrum)
        assert page.locator('#spectrum-chart circle[data-role=selected]').count() == count_epoch(2)
        page.locator('[data-appearance=gray]').click()
        assert '_color.webp' not in page.locator('#observation-image').get_attribute('src')
        page.locator('[data-appearance=colour]').click()
        assert '_color.webp' in page.locator('#observation-image').get_attribute('src')
        boxes = page.evaluate('''() => { const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};return {viewer:box('#viewer'),top:box('.observation-top'),bottom:box('.observation-controls'),left:box('.observation-info'),right:box('.observation-preview')}; }''')
        assert abs(boxes['viewer']['x']-120)<1 and abs(boxes['viewer']['y']-120)<1, boxes
        assert abs(boxes['top']['h']/boxes['bottom']['h']-6)<.05, boxes
        assert abs(boxes['right']['w']/boxes['left']['w']-2)<.05, boxes
        axis=page.locator('[data-role=wavelength-axis]').bounding_box()
        colour=page.locator('[data-role=wavelength-colour]').bounding_box()
        ticks=page.locator('[data-role=wavelength-tick]')
        assert abs(axis['x']-colour['x'])<1 and abs(axis['width']-colour['width'])<1
        assert 0 < colour['y']-axis['y'] < 12
        assert ticks.first.bounding_box()['y'] > colour['y']+colour['height']
        headers=[page.locator(selector).bounding_box()['y'] for selector in ['.image-type-control > .control-heading','.time-heading','#display-options > .control-heading']]
        rows=[page.locator(selector).bounding_box()['y'] for selector in ['#image-types','.date-selection-row','.display-appearance']]
        assert max(headers)-min(headers)<1 and max(rows)-min(rows)<1,(headers,rows)
        assert page.locator('#selected-date-range').count()==0
        page.screenshot(path='/tmp/spherex-viewer-desktop.png')
        page.locator('#time-start').fill('0')
        page.locator('[data-mode=compare]').click()
        assert page.locator('#spectrum-chart circle[data-series=A]').count() == count_epoch(0)
        assert page.locator('#spectrum-chart circle[data-series=B]').count() == count_epoch(2)
        expect(page.locator('#time-end')).to_be_visible()
        expect(page.locator('#legend-a')).to_be_visible()
        expect(page.locator('#legend-b')).to_be_visible()
        assert 'Image ' in page.locator('#spectrum-selection').inner_text()
        assert 'Hollow points' not in page.locator('#viewer').inner_text()
        page.screenshot(path='/tmp/spherex-controls-compare.png')
        first=page.locator('#observation-date').inner_text()
        page.wait_for_function('(date)=>document.querySelector("#observation-date").textContent!==date',arg=first)
        page.locator('#pause-play').click()
        frozen=page.locator('#observation-date').inner_text();page.wait_for_timeout(650)
        assert page.locator('#observation-date').inner_text()==frozen
        page.locator('[data-mode=timelapse]').click()
        dates=set()
        for _ in range(8): dates.add(page.locator('#observation-date').inner_text());page.wait_for_timeout(210)
        assert len(dates)>=3,dates
        page.locator('[data-mode=single]').click()
        expect(page.locator('#time-end')).to_be_hidden()
        page.locator('#time-start').fill('1')
        assert '2026' in page.locator('#observation-date').inner_text()
        viewport=page.locator('#frame-container');viewport.hover();page.mouse.wheel(0,-500)
        page.wait_for_timeout(80)
        before=page.locator('#observation-image').get_attribute('style')
        assert 'scale(1)' not in before
        bb=viewport.bounding_box();page.mouse.move(bb['x']+bb['width']/2,bb['y']+bb['height']/2);page.mouse.down();page.mouse.move(bb['x']+bb['width']/2+50,bb['y']+bb['height']/2+20);page.mouse.up()
        assert page.locator('#observation-image').get_attribute('style')!=before
        page.locator('#reset-image').click();assert 'scale(1)' in page.locator('#observation-image').get_attribute('style')
        page.locator('[data-source=detector]').click()
        expect(page.locator('#time-selection')).to_be_hidden()
        expect(page.locator('#display-options')).to_be_hidden()
        expect(page.locator('#detector-selection')).to_be_visible()
        page.locator('#observer-options button').first.click()
        expect(page.locator('#spectrum-selection')).to_have_text('Detector 1')
        assert 'μm' in page.locator('#detector-range').inner_text()
        assert page.locator('#spectrum-chart circle[data-role=selected]').count() == sum(p['detector']==1 for p in full_spectrum)
        expect(page.locator('#observation-image')).to_be_visible()
        page.wait_for_timeout(300)
        page.screenshot(path='/tmp/spherex-controls-detector.png')
        page.locator('[data-source=band]').click()
        expect(page.locator('#band-selection')).to_be_visible()
        expect(page.locator('#legend-a')).to_be_hidden()
        assert 'All observations' not in page.locator('#viewer').inner_text()
        page.locator('#band-slider').fill('34')
        expect(page.locator('#observation-image')).to_have_attribute('src', __import__('re').compile(r'b34\.webp$'))
        assert 'μm' in page.locator('#band-range').inner_text()
        assert 'Band 35 / 102' in page.locator('#band-detail').inner_text()
        assert page.locator('#spectrum-chart [data-role=wavelength-highlight]').count()==1
        band=json.loads((ROOT/'static_export/barnards-star/bands.json').read_text())['bands'][34]
        assert page.locator('#spectrum-chart circle[data-role=selected]').count()==sum(band['wavelength_um_min']<=p['wavelength_um']<=band['wavelength_um_max'] and p['detector']==band['detector'] for p in full_spectrum)
        assert 'linear-gradient' in page.locator('#band-slider').get_attribute('style')
        expect(page.locator('#observation-image')).to_be_visible()
        expect(page.locator('[data-source=band]')).to_have_attribute('aria-pressed','true')
        page.wait_for_timeout(300)
        page.screenshot(path='/tmp/spherex-controls-band.png')
        page.locator('#share-view').click()
        expect(page.locator('#share-status')).to_have_text('Link copied')
        band_link=page.evaluate('navigator.clipboard.readText()')
        assert 'view=band' in band_link and 'band=34' in band_link
        page.goto(band_link);page.wait_for_load_state('networkidle')
        expect(page.locator('#viewer')).to_be_visible(timeout=45000)
        expect(page.locator('[data-source=band]')).to_have_attribute('aria-pressed','true')
        expect(page.locator('#band-slider')).to_have_value('34')
        page.locator('[data-source=epoch]').click()
        expect(page.locator('#display-options')).to_be_visible()
        expect(page.locator('#band-selection')).to_be_hidden()
        page.locator('#share-view').click();expect(page.locator('#share-status')).to_have_text('Link copied')
        link=page.evaluate('navigator.clipboard.readText()');assert 'target=barnards-star' in link and 'frame=1' in link
        page.locator('#back-to-sky').click();expect(page.locator('#viewer')).to_be_hidden()
        page.goto(link);page.wait_for_load_state('networkidle');expect(page.locator('#viewer')).to_be_visible(timeout=45000)
        expect(page.locator('#time-start')).to_have_value('1')
        page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200)
        assert page.locator('.observation-info').bounding_box()['height'] > 250
        page.screenshot(path='/tmp/spherex-viewer-mobile.png')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        # Endpoint failure must not prevent valid frame data from opening.
        page.route('**/api/spherex/spectrum?*',lambda route:route.fulfill(status=503,json={'error':'unavailable'}))
        page.route('**/api/spherex/frames_by_band?*',lambda route:route.fulfill(status=404,json={'error':'unavailable'}))
        page.set_viewport_size({'width':1440,'height':960})
        page.goto(link);page.wait_for_load_state('networkidle')
        expect(page.locator('#viewer')).to_be_visible(timeout=45000)
        expect(page.locator('#spectrum-message')).to_have_text('Spectrum unavailable for this target.')
        page.locator('[data-source=band]').click()
        expect(page.locator('#band-slider')).to_be_disabled()
        expect(page.locator('#image-message')).to_have_text('No image available for this selection.')
        page.locator('[data-source=epoch]').click()
        expect(page.locator('#observation-image')).to_be_visible()
        page.locator('#back-to-sky').click()
        expect(page.locator('#viewer')).to_be_hidden()
        page.unroute('**/api/spherex/spectrum?*')
        page.route('**/api/spherex/spectrum?*',lambda route:route.fulfill(json={'spectrum':[{'wavelength_um':1.2,'flux':3,'mjd':0,'detector':1}]}))
        page.goto(link);page.wait_for_load_state('networkidle')
        expect(page.locator('#viewer')).to_be_visible(timeout=45000)
        expect(page.locator('#spectrum-message')).to_have_text('No spectrum measurements in this selection.')
        assert page.locator('#spectrum-chart circle[data-role=selected]').count()==0
        assert not errors, errors
        print('PASS: layout, three image types, colour/grayscale, exact epoch/compare/detector/band spectrum linking, gradient slider, playback, zoom, share, mobile and unavailable data.')
    finally:
        browser.close();upstream.shutdown()
