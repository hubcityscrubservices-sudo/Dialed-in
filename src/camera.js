// Perspective camera for the aim range. Games draw with a rectilinear (pinhole) projection, so a
// target near the crosshair moves across the screen at f * tan(angle), not at a fixed number of
// pixels per degree. Rendering the same way, at the player's own field of view, makes on-screen
// motion match the game for the same turn speed. Drawing only: scoring works in angles.
const RAD = Math.PI / 180;

// Games state field of view three ways. All return the horizontal FOV on a 16:9 screen, in degrees.
//   h169: horizontal degrees at 16:9 (most current games)
//   h43:  horizontal degrees measured on a 4:3 frame, widened for 16:9 (Apex, CS)
//   v:    vertical degrees
export function hfov169(value, type = 'h169', aspect = 16 / 9) {
  if (type === 'h169') return value;
  if (type === 'h43') return 2 * Math.atan(Math.tan(value * RAD / 2) * aspect / (4 / 3)) / RAD;
  if (type === 'v') return 2 * Math.atan(Math.tan(value * RAD / 2) * aspect) / RAD;
  throw new Error(`Unknown FOV type ${type}`);
}

// Aiming down sights narrows the view: the zoom factor divides tan(FOV / 2).
export function zoomedFov(hfov, zoom) {
  return 2 * Math.atan(Math.tan(hfov * RAD / 2) / zoom) / RAD;
}

// view = { yaw, pitch } in degrees; hfov = the game's horizontal FOV on a 16:9 screen. A canvas of another
// shape keeps the vertical FOV and widens or narrows sideways (Hor+), as games do. fov = the canvas's own.
export function makeCamera(view, W, H, hfov, zoom = 1) {
  const f = (H * 8 / 9) / Math.tan(zoomedFov(hfov, zoom) * RAD / 2);
  const fov = 2 * Math.atan(W / 2 / f) / RAD;
  const cy = Math.cos(view.yaw * RAD), sy = Math.sin(view.yaw * RAD);
  const cp = Math.cos(view.pitch * RAD), sp = Math.sin(view.pitch * RAD);
  const cam = {
    yaw: view.yaw, pitch: view.pitch, W, H, cx: W / 2, cy: H / 2, f, fov, zoom,
    ppd: f * RAD, // pixels per degree at the crosshair
    // World direction (yaw right of north, pitch up) -> screen point. u, v are camera-space right and up
    // (for direction arrows); z is depth, <= 0 means behind the camera.
    project(yaw, pitch) {
      const a = yaw * RAD, p = pitch * RAD;
      const x = Math.cos(p) * Math.sin(a), y = Math.sin(p), z = Math.cos(p) * Math.cos(a);
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
      const v = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      return { x: cam.cx + f * x1 / z2, y: cam.cy - f * v / z2, z: z2, u: x1, v };
    }
  };
  return cam;
}
