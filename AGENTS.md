# Instruksi untuk Codex, Antigravity, dan OpenCode

Gunakan aturan ini saat bekerja di direktori ini. Ikuti instruksi sistem, permintaan pengguna, dan aturan proyek yang lebih spesifik.

Gunakan skill `poteto-mode` untuk memilih playbook jika tersedia. Alur berikut mengikuti [pstack Superboard](https://erictechpro.github.io/super-board/pstack/). Tahap adalah urutan kerja, bukan nama skill. Jalankan tahap yang relevan sesuai lingkup tugas; tugas kecil tidak memerlukan semua playbook.

1. **Plan.** Rumuskan hasil yang dapat diperiksa. Baca instruksi proyek, alur kode, pemanggil, pengujian, dan alasan keputusan yang relevan. Gunakan `how` atau `why` jika tersedia. Jawab pertanyaan faktual dengan pemeriksaan atau percobaan kecil. Untuk pekerjaan besar atau berisiko, gunakan `figure-it-out` bila tersedia.
2. **Design.** Tentukan bentuk data, batas modul, dan cara pemanggil memakai perubahan sebelum menulis kode. Pilih rancangan paling sederhana yang memenuhi kebutuhan. Gunakan prototipe, `architect`, atau `arena` hanya ketika pilihan rancangan perlu dibuktikan atau mahal untuk dibalik.
3. **Build.** Buat perubahan terkecil yang menyelesaikan tugas secara utuh. Gunakan pola dan dependensi yang sudah ada. Tulis pengujian lebih dulu jika jalurnya murah dan berguna. Jaga kompatibilitas, validasi, penanganan kesalahan, keamanan, dan aksesibilitas. Bersihkan perubahan dan hapus komentar yang tidak menjelaskan alasan penting.
4. **Test.** Periksa hasil pada aplikasi atau artefak nyata, bukan hanya keberhasilan kompilasi. Jalankan pengujian yang relevan, tinjau dampak ke pemanggil, dan periksa perubahan akhir. Periksa metode pengukuran sebelum melaporkan angka performa. Minta tinjauan tambahan jika rancangan atau risikonya masih diperdebatkan.
5. **Deploy.** Jika proyek memakai pull request, siapkan perubahan yang mudah ditinjau. Selesaikan konflik, komentar ulasan, dan CI sebelum penggabungan yang diotorisasi. Pada pstack, tahap ini berakhir saat perubahan digabungkan; rilis, rollout, dan rollback mengikuti prosedur proyek yang terpisah.
6. **Maintain.** Pstack belum menyediakan skill untuk pemeliharaan produk setelah rilis. Jika tugas mencakup rilis atau operasi, ikuti runbook proyek untuk memantau log, galat, dan metrik. Tangani masalah yang ditemukan, lalu bawa temuan itu kembali ke Plan. Jika akses pemantauan tidak tersedia, laporkan batas verifikasinya.

## Anytime

Gunakan skill berikut pada tahap mana pun jika tersedia dan relevan. Anytime bukan tahap ketujuh.

- **Router dan bantuan.** `poteto-mode` memilih playbook. `setup-pstack` mengatur model, dan `poteto-help` menjawab pertanyaan penggunaan.
- **Konteks dan komunikasi.** `recall` memulihkan konteks, `ketchup` merangkum percakapan, `bro` menyederhanakan penjelasan, dan `what-did-i-get-done` merangkum commit.
- **Tulisan.** Gunakan `technical-writing` untuk dokumen dan `unslop` untuk membuang gaya bahasa yang tidak perlu.
- **Perbaikan cara kerja agen.** `reflect`, `correct`, `automate-me`, dan `maintain-verification-skill` memperbaiki skill atau proses agen. Ini berbeda dari pemeliharaan produk pada tahap Maintain.
- **Khusus Cursor.** `make-bot-ui` tidak berlaku untuk Codex, Antigravity, atau OpenCode.

## Prinsip lintas tahap

Terapkan prinsip yang sesuai dengan masalah. Jika skill terkait tersedia, baca isinya sebelum menggunakannya.

- **Keep it small.** Kurangi kode dan beban baca, arahkan perubahan ke bentuk akhir, lalu hapus API lama setelah pemanggil berpindah. Skill: `laziness-protocol`, `subtract-before-you-add`, `minimize-reader-load`, `outcome-oriented-execution`, `migrate-callers-then-delete-legacy-apis`.
- **Design the shape.** Bentuk data lebih dulu, uji asumsi, dan bandingkan rancangan saat keputusan sulit dibalik. Skill: `foundational-thinking`, `redesign-from-first-principles`, `attack-the-premise`, `experience-first`, `exhaust-the-design-space`.
- **Code structure and safety.** Modelkan aturan pada struktur yang tepat, validasi di batas sistem, jaga tipe dan operasi ulang, serta pisahkan state yang ditulis bersama. Skill: `model-the-domain`, `boundary-discipline`, `type-system-discipline`, `make-operations-idempotent`, `separate-before-serializing-shared-state`.
- **Prove it.** Periksa artefak nyata, akar masalah, perilaku, dan angka yang dilaporkan dalam langkah kecil. Skill: `prove-it-works`, `fix-root-causes`, `sequence-verifiable-units`, `test-behavior-not-implementation`, `explain-the-number`.
- **Work well with agents.** Buat alat verifikasi bila perlu, jaga konteks, lanjutkan pekerjaan yang aman tanpa menunggu pengguna, dan ubah pelajaran berulang menjadi pemeriksaan. Skill: `build-the-lever`, `guard-the-context-window`, `never-block-on-the-human`, `encode-lessons-in-structure`.

Jangan menimpa perubahan pengguna atau melakukan operasi destruktif tanpa otorisasi. Laporkan perubahan, bukti pemeriksaan, dan risiko yang masih ada secara ringkas dalam bahasa pengguna.
