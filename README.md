# DevBar

Aynı anda birçok Claude Code oturumu çalıştıranlar için: ekranın tepesinde durum barı, oturumları yöneten bir pencere ve telefondan erişim (Windows, Tauri 2).

- **Üst bar:** solda DevBar menüsü ve geliştirici göstergeleri (geliştirme portları, Docker, değişikliği olan repolar, CPU/RAM), ortada en acil oturum, sağda tüm Claude oturumları. Her öğeye tıklayınca bardan aşağı bir çekmece açılır:
  - **Portlar:** hangi portta hangi süreç, hangi proje klasöründen, hangi komutla çalışıyor; tarayıcıda aç, VS Code'da aç, süreci kapat.
  - **Docker, Git, Sistem:** container'lar ve portları, repoların branch/değişiklik durumu, CPU/RAM ve en çok bellek kullananlar.
  - **Oturum:** durum, terminalin son satırları, izin sorusuna tek tıkla cevap, hızlı yanıt. Oturumlara isim verilebilir.
- **Ana pencere:** solda DevBar'daki ve dışarıdaki (terminal, VS Code) oturumlar, sağda seçili oturumun gerçek terminali ve altta mesaj kutusu. Etkileşimli `claude` çalışır: izinler, slash komutlar, MCP, her şey.
- Durumlar Claude Code hook'larından gelir. Uzun süren iş bitince ve oturum seni beklerken Windows bildirimi gelir.
- `Ctrl+Alt+Space` ya da sağ alttaki tepsi ikonu ile pencere açılır/gizlenir. Pencereyi kapatmak oturumları durdurmaz.

Geliştirme: `npm install`, sonra `npx tauri dev`. Kurulum paketi: `npx tauri build`.

## Telefondan erişim

Telefondan bütün oturumları canlı izleyebilir (izin bekleyenler en üstte), bir DevBar sekmesinin terminalini açıp yazabilir, izin sorularını Enter, Esc, 1/2/3 ve ok tuşlarıyla yanıtlayabilir, son klasörlerden birinde yeni oturum açabilirsin. DevBar dışındaki terminal oturumları telefondan sadece izlenir.

### Evde (aynı Wi-Fi)

1. Bilgisayarda DevBar → Ayarlar → **Telefon erişimi**'ni aç.
2. Çıkan QR kodu telefonun kamerasıyla okut. Sayfa açılır ve bağlanır; istersen ana ekrana ekle.
3. İlk açılışta Windows güvenlik duvarı izin isteyebilir, **Özel ağlar**'a izin ver.

DevBar, telefon arayüzünü ve API'yi `http://<bilgisayarın-ip>:47822` adresinden kendisi sunar, ek kurulum gerekmez.

### Dışarıdan (GitHub Pages + Tailscale)

Telefon arayüzünün bir kopyası https://alperkosay.github.io/devbar/ adresinde. HTTPS bir sayfa evdeki `http://192.168...` adresine bağlanamadığı için bu kopya, DevBar'a HTTPS bir adresten ulaşıldığında işe yarar:

1. Bilgisayarda ve telefonda [Tailscale](https://tailscale.com) kurulu ve aynı tailnet'te olsun.
2. Bilgisayarda: `tailscale serve --bg 47822`. Tailscale, DevBar'ı `https://<bilgisayar>.<tailnet>.ts.net` adresinde açar.
3. Telefonda Pages kopyasını aç, **Bağlantı** ekranında sunucu adresine bu HTTPS adresi, token'a da DevBar'daki QR'ın token'ını yaz.

Tailscale adresini doğrudan telefonda açmak da olur; o zaman sayfa ve API aynı adresten gelir.

### Güvenlik

- Telefon erişimi **varsayılan olarak kapalı**. Açıkken DevBar 47822 portunu dinler.
- Her API isteği 64 karakterlik rastgele bir token ister (sabit sürede karşılaştırılır). Token QR'ın içinde: QR'ı kimseyle paylaşma, token oturumlarına yazma izni verir.
- Ayarlardaki **Token'ı yenile** eski token'ı geçersiz kılar ve bağlı telefonları düşürür.
- Sunucu yalnızca `https://alperkosay.github.io` kaynağına CORS izni verir.
- Sadece Tailscale üzerinden erişmek istersen DevBar'ı `ADA_REMOTE_HOST=127.0.0.1` ortam değişkeniyle başlat; böylece yerel ağa hiç açılmaz, `tailscale serve` yine ulaşır.

### API

Bütün `/api` istekleri `Authorization: Bearer <token>` ya da `?token=<token>` ister.

| İstek | Açıklama |
|---|---|
| `GET /api/state` | `{agents, tabs, recent, defaultCwd}` |
| `GET /api/events?tabs=<id>` | Server-Sent Events: `state`, `agent`, `agent-remove`, `tab`, `tab-remove`; `tabs` ile abone olunan sekmeler için `screen` (son ~64 KB çıktı), `pty` ve `size` |
| `GET /api/tabs/<id>/buffer` | Sekmenin son ~64 KB ham terminal çıktısı ve boyutu |
| `POST /api/tabs/<id>/input` | `{data}` terminale yazılır |
| `POST /api/tabs/<id>/start` | Kapalı sekmeyi başlatır (`--resume`) |
| `POST /api/tabs` | `{cwd}` klasöründe yeni sekme açar ve başlatır |

Telefon terminali yeniden boyutlandırmaz: masaüstüyle aynı sütun ve satırda çizer, geniş ekranı yatay kaydırır. Böylece bilgisayardaki görüntü bozulmaz.
