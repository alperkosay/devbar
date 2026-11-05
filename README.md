# Ada

Aynı anda birçok Claude Code oturumu çalıştıranlar için ekranın tepesinde duran bir status bar ve ada (Windows, Tauri 2).

- Her sekme gerçek bir terminalde etkileşimli `claude` çalıştırır: izinler, slash komutlar, her şey.
- Claude Code hook'ları sayesinde Ada'daki ve dışarıdaki (terminal, VS Code) tüm oturumların durumu canlı görünür: çalışıyor, izin bekliyor, bitti.
- `Ctrl+Alt+Space` ile her yerden açılır ve kapanır.

Geliştirme: `npm install`, sonra `npx tauri dev`. Kurulum paketi: `npx tauri build`.

## Telefondan erişim

Telefondan bütün oturumları canlı izleyebilir (izin bekleyenler en üstte), bir Ada sekmesinin terminalini açıp yazabilir, izin sorularını Enter, Esc, 1/2/3 ve ok tuşlarıyla yanıtlayabilir, son klasörlerden birinde yeni oturum açabilirsin. Ada dışındaki terminal oturumları telefondan sadece izlenir.

### Evde (aynı Wi-Fi)

1. Bilgisayarda Ada → Ayarlar → **Telefon erişimi**'ni aç.
2. Çıkan QR kodu telefonun kamerasıyla okut. Sayfa açılır ve bağlanır; istersen ana ekrana ekle.
3. İlk açılışta Windows güvenlik duvarı izin isteyebilir, **Özel ağlar**'a izin ver.

Ada, telefon arayüzünü ve API'yi `http://<bilgisayarın-ip>:47822` adresinden kendisi sunar, ek kurulum gerekmez.

### Dışarıdan (GitHub Pages + Tailscale)

Telefon arayüzünün bir kopyası https://alperkosay.github.io/ada/ adresinde. HTTPS bir sayfa evdeki `http://192.168...` adresine bağlanamadığı için bu kopya, Ada'ya HTTPS bir adresten ulaşıldığında işe yarar:

1. Bilgisayarda ve telefonda [Tailscale](https://tailscale.com) kurulu ve aynı tailnet'te olsun.
2. Bilgisayarda: `tailscale serve --bg 47822`. Tailscale, Ada'yı `https://<bilgisayar>.<tailnet>.ts.net` adresinde açar.
3. Telefonda Pages kopyasını aç, **Bağlantı** ekranında sunucu adresine bu HTTPS adresi, token'a da Ada'daki QR'ın token'ını yaz.

Tailscale adresini doğrudan telefonda açmak da olur; o zaman sayfa ve API aynı adresten gelir.

### Güvenlik

- Telefon erişimi **varsayılan olarak kapalı**. Açıkken Ada 47822 portunu dinler.
- Her API isteği 64 karakterlik rastgele bir token ister (sabit sürede karşılaştırılır). Token QR'ın içinde: QR'ı kimseyle paylaşma, token oturumlarına yazma izni verir.
- Ayarlardaki **Token'ı yenile** eski token'ı geçersiz kılar ve bağlı telefonları düşürür.
- Sunucu yalnızca `https://alperkosay.github.io` kaynağına CORS izni verir.
- Sadece Tailscale üzerinden erişmek istersen Ada'yı `ADA_REMOTE_HOST=127.0.0.1` ortam değişkeniyle başlat; böylece yerel ağa hiç açılmaz, `tailscale serve` yine ulaşır.

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
