// electron-builder afterPack kancası (macOS):
// Paketleme Info.plist/kaynakları değiştirdiği için Electron'un fabrika
// ad-hoc imzasının mührü bozulur; indirilen uygulama Apple Silicon'da
// "hasar görmüş" diye açılmaz. Burada bundle bütün olarak yeniden ad-hoc
// imzalanır — Gatekeeper böylece bilinen "doğrulanamadı" uyarısına düşer
// (sağ tık → Aç ile geçilir). Developer ID imzası eklendiğinde bu kanca
// gereksizleşir ama zararsızdır (electron-builder gerçek imzayı sonra atar).
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appPath}`);
};
