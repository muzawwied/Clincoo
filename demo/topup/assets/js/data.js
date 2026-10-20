/* Data katalog game — logo resmi diambil dari Wikimedia Commons / Wikipedia */
window.GAMES = [
  {
    slug: "ml", name: "Mobile Legends: Bang Bang", publisher: "Moonton",
    genre: "MOBA", logo: "/assets/demo/vylonium-topup/assets/img/logos/ml.png", popular: true,
    idLabel: "User ID", idHint: "Lihat di profil in-game kamu (angka).",
    serverLabel: "Server / Zone ID", serverHint: "Contoh: 2214",
    denoms: [
      { label: "86 Diamonds", price: 19500, note: "+8 bonus DM" },
      { label: "172 Diamonds", price: 38000, note: "+16 bonus DM" },
      { label: "257 Diamonds", price: 56000, note: "+24 bonus DM" },
      { label: "344 Diamonds", price: 74500, note: "+32 bonus DM" },
      { label: "514 Diamonds", price: 111000, note: "+48 bonus DM" },
      { label: "706 Diamonds", price: 151000, note: "+65 bonus DM" },
      { label: "1050 Diamonds", price: 223000, note: "+97 bonus DM" },
      { label: "2195 Diamonds", price: 462000, note: "+203 bonus DM" },
      { label: "Weekly Diamond Pass", price: 28000, note: "Langganan 7 hari" },
      { label: "Twilight Pass", price: 295000, note: "Sekali beli per season" }
    ]
  },
  {
    slug: "ff", name: "Free Fire (MAX)", publisher: "Garena",
    genre: "Battle Royale", logo: "/assets/demo/vylonium-topup/assets/img/logos/ff.png", popular: true,
    idLabel: "User ID", idHint: "Angka di halaman profil akun FF kamu.",
    denoms: [
      { label: "5 Diamonds", price: 1000, note: "Paket kecil" },
      { label: "12 Diamonds", price: 2000, note: "Paket kecil" },
      { label: "50 Diamonds", price: 7000, note: "+5 bonus DM" },
      { label: "70 Diamonds", price: 10000, note: "+7 bonus DM" },
      { label: "140 Diamonds", price: 19500, note: "+14 bonus DM" },
      { label: "355 Diamonds", price: 49000, note: "+35 bonus DM" },
      { label: "720 Diamonds", price: 98000, note: "+70 bonus DM" },
      { label: "1450 Diamonds", price: 195000, note: "+145 bonus DM" },
      { label: "Membership Mingguan", price: 28500, note: "Langganan 7 hari" },
      { label: "Membership Bulanan", price: 92000, note: "Langganan 30 hari" }
    ]
  },
  {
    slug: "pubg", name: "PUBG Mobile", publisher: "Level Infinite",
    genre: "Battle Royale", logo: "/assets/demo/vylonium-topup/assets/img/logos/pubg.svg", popular: true,
    idLabel: "Character ID", idHint: "Angka ID di profil PUBG Mobile kamu.",
    denoms: [
      { label: "60 UC", price: 13000, note: "Paket hemat" },
      { label: "325 UC", price: 64500, note: "+25 bonus UC" },
      { label: "660 UC", price: 128000, note: "+60 bonus UC" },
      { label: "1800 UC", price: 345000, note: "+150 bonus UC" },
      { label: "3850 UC", price: 720000, note: "+350 bonus UC" },
      { label: "8100 UC", price: 1500000, note: "+800 bonus UC" }
    ]
  },
  {
    slug: "genshin", name: "Genshin Impact", publisher: "HoYoverse",
    genre: "RPG", logo: "/assets/demo/vylonium-topup/assets/img/logos/genshin.svg", popular: true,
    idLabel: "UID (9 digit)", idHint: "Lihat di pojok bawah layar profil.",
    denoms: [
      { label: "60 Genesis Crystals", price: 15000, note: "Paket hemat" },
      { label: "330 Genesis Crystals", price: 78000, note: "+30 bonus" },
      { label: "1090 Genesis Crystals", price: 245000, note: "+90 bonus" },
      { label: "2240 Genesis Crystals", price: 490000, note: "+240 bonus" },
      { label: "3880 Genesis Crystals", price: 840000, note: "+480 bonus" },
      { label: "Blessing of the Welkin Moon", price: 73000, note: "Langganan 30 hari" }
    ]
  },
  {
    slug: "valorant", name: "Valorant", publisher: "Riot Games",
    genre: "FPS", logo: "/assets/demo/vylonium-topup/assets/img/logos/valorant.svg", popular: false,
    idLabel: "Riot ID", idHint: "Format: Nama#Tag (contoh: Vylonium#1234).",
    denoms: [
      { label: "475 VP", price: 50000, note: "Paket hemat" },
      { label: "1000 VP", price: 100000, note: "Paket standar" },
      { label: "2050 VP", price: 200000, note: "+50 bonus VP" },
      { label: "3650 VP", price: 350000, note: "+150 bonus VP" },
      { label: "5350 VP", price: 500000, note: "+350 bonus VP" }
    ]
  },
  {
    slug: "codm", name: "Call of Duty: Mobile", publisher: "Activision",
    genre: "FPS", logo: "/assets/demo/vylonium-topup/assets/img/logos/codm.png", popular: false,
    idLabel: "UID Akun", idHint: "Lihat di halaman profil CODM kamu.",
    denoms: [
      { label: "80 CP", price: 15000, note: "Paket hemat" },
      { label: "420 CP", price: 74000, note: "+20 bonus CP" },
      { label: "880 CP", price: 148000, note: "+40 bonus CP" },
      { label: "2400 CP", price: 385000, note: "+200 bonus CP" },
      { label: "4800 CP", price: 760000, note: "+400 bonus CP" }
    ]
  },
  {
    slug: "hsr", name: "Honkai: Star Rail", publisher: "HoYoverse",
    genre: "RPG", logo: "/assets/demo/vylonium-topup/assets/img/logos/hsr.svg", popular: true,
    idLabel: "UID (9 digit)", idHint: "Lihat di menu profil in-game.",
    denoms: [
      { label: "60 Oneiric Shards", price: 15000, note: "Paket hemat" },
      { label: "330 Oneiric Shards", price: 76000, note: "+30 bonus" },
      { label: "1090 Oneiric Shards", price: 245000, note: "+90 bonus" },
      { label: "2240 Oneiric Shards", price: 490000, note: "+240 bonus" },
      { label: "3880 Oneiric Shards", price: 840000, note: "+480 bonus" },
      { label: "Express Supply Pass", price: 88000, note: "Langganan 30 hari" }
    ]
  },
  {
    slug: "roblox", name: "Roblox", publisher: "Roblox Corporation",
    genre: "Sandbox", logo: "/assets/demo/vylonium-topup/assets/img/logos/roblox.svg", popular: false,
    idLabel: "Username Roblox", idHint: "Bukan nama tampilan — username akun.",
    denoms: [
      { label: "80 Robux", price: 16000, note: "Paket hemat" },
      { label: "400 Robux", price: 75000, note: "Paket standar" },
      { label: "800 Robux", price: 145000, note: "Paket besar" },
      { label: "1700 Robux", price: 295000, note: "Paket besar" },
      { label: "4500 Robux", price: 750000, note: "Paket premium" }
    ]
  },
  {
    slug: "fortnite", name: "Fortnite", publisher: "Epic Games",
    genre: "Battle Royale", logo: "/assets/demo/vylonium-topup/assets/img/logos/fortnite.svg", popular: false,
    idLabel: "Epic Username", idHint: "Username akun Epic Games kamu.",
    denoms: [
      { label: "1000 V-Bucks", price: 135000, note: "Paket standar" },
      { label: "2800 V-Bucks", price: 365000, note: "+100 bonus" },
      { label: "5000 V-Bucks", price: 640000, note: "+300 bonus" },
      { label: "13500 V-Bucks", price: 1700000, note: "+1500 bonus" }
    ]
  },
  {
    slug: "clashroyale", name: "Clash Royale", publisher: "Supercell",
    genre: "Strategy", logo: "/assets/demo/vylonium-topup/assets/img/logos/clashroyale.png", popular: false,
    idLabel: "Player Tag", idHint: "Format #XXXXXXXX di profil.",
    denoms: [
      { label: "80 Gems", price: 15000, note: "Paket hemat" },
      { label: "500 Gems", price: 89000, note: "Paket standar" },
      { label: "1200 Gems", price: 210000, note: "+100 bonus" },
      { label: "2500 Gems", price: 420000, note: "+250 bonus" },
      { label: "6500 Gems", price: 1050000, note: "+700 bonus" }
    ]
  },
  {
    slug: "minecraft", name: "Minecraft", publisher: "Mojang Studios",
    genre: "Sandbox", logo: "/assets/demo/vylonium-topup/assets/img/logos/minecraft.png", popular: false,
    idLabel: "Email / Username Minecraft", idHint: "Email akun Minecraft kamu.",
    denoms: [
      { label: "1720 Minecoins", price: 155000, note: "Bedrock Edition" },
      { label: "3500 Minecoins", price: 310000, note: "Bedrock Edition" },
      { label: "8000 Minecoins", price: 700000, note: "Bedrock Edition" }
    ]
  },
  {
    slug: "efootball", name: "eFootball", publisher: "Konami",
    genre: "Sports", logo: "/assets/demo/vylonium-topup/assets/img/logos/efootball.svg", popular: false,
    idLabel: "KONAMI ID", idHint: "ID akun eFootball kamu.",
    denoms: [
      { label: "110 Coins", price: 16000, note: "Paket hemat" },
      { label: "550 Coins", price: 78000, note: "Paket standar" },
      { label: "1300 Coins", price: 175000, note: "+100 bonus" },
      { label: "2800 Coins", price: 350000, note: "+300 bonus" },
      { label: "6500 Coins", price: 790000, note: "+800 bonus" }
    ]
  }
];

window.PAYMENTS = [
  { code: "qris", name: "QRIS", note: "Semua e-wallet & m-banking · instan" },
  { code: "gopay", name: "GoPay", note: "E-wallet · instan · bebas biaya" },
  { code: "ovo", name: "OVO", note: "E-wallet · instan · bebas biaya" },
  { code: "dana", name: "DANA", note: "E-wallet · instan · bebas biaya" },
  { code: "shopeepay", name: "ShopeePay", note: "E-wallet · instan · bebas biaya" },
  { code: "bca", name: "BCA Virtual Account", note: "Transfer bank · verifikasi otomatis" },
  { code: "bri", name: "BRI Virtual Account", note: "Transfer bank · verifikasi otomatis" },
  { code: "retail", name: "Alfamart / Indomaret", note: "Bayar tunai di kasir · 15 menit" }
];
