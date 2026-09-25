# Etusivun esimerkkikuvat PDF:istä WebP:ksi (tools/hero-kuvat.js tekee PDF:t tuotannosta).
# Juliste: 1. sivu. Vihko: A5-aukeaman vasen sivu (kartta + reittijana), valkoinen alaosa rajattuna.
# Ajo: python tools/hero-kuvat.py   (tarvitsee pymupdf + Pillow)
import json, os, pymupdf
from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '.hero-pdf')
OUT = os.path.join(HERE, '..', 'img', 'hero')
os.makedirs(OUT, exist_ok=True)

def trim(im, pad=12):
    bg = Image.new(im.mode, im.size, (255, 255, 255))
    box = ImageChops.difference(im, bg).convert('L').point(lambda v: 255 if v > 12 else 0).getbbox()
    if not box: return im
    l, t, r, b = box
    return im.crop((max(0, l - pad), max(0, t - pad), min(im.width, r + pad), min(im.height, b + pad)))

def render(page, clip, width_px):
    zoom = width_px / clip.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
    return Image.frombytes('RGB', (pix.width, pix.height), pix.samples)

valinnat = json.load(open(os.path.join(SRC, 'valinnat.json'), encoding='utf-8'))
index = {}
for city, v in sorted(valinnat.items()):
    j = pymupdf.open(os.path.join(SRC, city + '-juliste.pdf'))[0]
    poster = render(j, j.rect, 720)
    poster.save(os.path.join(OUT, city + '-juliste.webp'), 'WEBP', quality=80, method=6)
    vd = pymupdf.open(os.path.join(SRC, city + '-vihko.pdf'))
    vp = vd[1] if len(vd) > 1 else vd[0]
    r = vp.rect
    # Vasen A5-sivu ilman taiteviivaa: sivujen välinen katkoviiva estäisi tyhjän alaosan rajauksen.
    vihko = trim(render(vp, pymupdf.Rect(0, 0, r.width * 0.485, r.height), 760))
    vihko.save(os.path.join(OUT, city + '-vihko.webp'), 'WEBP', quality=80, method=6)
    index[city] = {'stop': v['stopName'], 'line': v['line'], 'date': v['date'],
                   'poster': [poster.width, poster.height], 'booklet': [vihko.width, vihko.height]}
    kb = sum(os.path.getsize(os.path.join(OUT, city + s)) for s in ('-juliste.webp', '-vihko.webp')) // 1024
    print(f'{city:13} {v["stopName"][:30]:30} linja {v["line"]:5} {kb} kt')
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('kaupunkeja', len(index))
