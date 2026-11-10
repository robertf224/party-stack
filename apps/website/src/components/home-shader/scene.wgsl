struct Params {
    resolution: vec2f,
    time: f32,
    viewportWidth: f32,
    light: vec2f,
};
@group(0) @binding(0) var<uniform> params: Params;
const PI = 3.14159265;
const TAU = 6.2831853;
const RADIUS = 0.84;
const GRID = vec2f(24.0, 12.0);
const KEY = vec3f(-3.4, 3.8, 2.5);
fn keyLight() -> vec3f { return KEY + vec3f(params.light.x * 6.0, params.light.y * 5.0, 0.0); }
const FILL = vec3f(3.0, 2.3, 1.7);

fn rotate(p: vec2f, angle: f32) -> vec2f {
    return mat2x2f(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
}
fn palette(index: u32) -> vec3f {
    let colors = array<vec3f, 7>(
        vec3f(0.718, 0.604, 0.925), vec3f(0.522, 0.784, 0.925),
        vec3f(0.616, 0.875, 0.733), vec3f(0.957, 0.839, 0.506),
        vec3f(0.953, 0.643, 0.702), vec3f(0.631, 0.655, 0.929),
        vec3f(0.773, 0.875, 0.627),
    );
    return colors[index % 7u];
}
fn toBall(point: vec3f) -> vec3f {
    let tilt = rotate(point.xy, -0.12);
    let spin = rotate(vec2f(tilt.x, point.z), params.time * 0.22);
    return vec3f(spin.x, tilt.y, spin.y);
}
fn fromBall(point: vec3f) -> vec3f {
    let spin = rotate(point.xz, -params.time * 0.22);
    let tilt = rotate(vec2f(spin.x, point.y), 0.12);
    return vec3f(tilt, spin.y);
}
fn ballUV(n: vec3f) -> vec2f {
    let p = toBall(n);
    return vec2f(atan2(p.z, p.x) / TAU + 0.5, asin(clamp(p.y, -1.0, 1.0)) / PI + 0.5);
}
fn cellNormal(cell: vec2f) -> vec3f {
    let center = (cell + 0.5) / GRID;
    let longitude = (center.x - 0.5) * TAU;
    let latitude = (center.y - 0.5) * PI;
    return normalize(fromBall(vec3f(cos(latitude) * cos(longitude), sin(latitude), cos(latitude) * sin(longitude))));
}
fn hash(cell: vec2f) -> f32 { return fract(sin(dot(cell, vec2f(127.1, 311.7))) * 43758.5453); }

// Analytic ray intersections: the ball, a floor, and the back wall.
fn roomHit(origin: vec3f, direction: vec3f) -> vec4f {
    var wall = 10000.0;
    var floor = 10000.0;
    if (direction.z < -0.0001) { wall = (-2.8 - origin.z) / direction.z; }
    if (direction.y < -0.0001) { floor = (-1.35 - origin.y) / direction.y; }
    return vec4f(origin + direction * min(wall, floor), select(0.0, 1.0, floor < wall));
}
fn roomColor(point: vec4f) -> vec3f {
    var color = vec3f(0.004, 0.004, 0.009);
    color += vec3f(0.006, 0.002, 0.014) * exp(-length(point.xz) * 0.22);
    // Trace a small set of reflected light rays from rotating mirror facets.
    for (var i = 0u; i < 12u; i++) {
        let angle = f32(i) * TAU / 12.0;
        let latitude = -0.30 + f32(i % 3u) * 0.34;
        let n = fromBall(vec3f(cos(latitude) * cos(angle), sin(latitude), cos(latitude) * sin(angle)));
        let origin = n * (RADIUS + 0.005);
        let bounce = reflect(normalize(origin - keyLight()), n);
        let destination = roomHit(origin, bounce);
        let facing = max(dot(n, normalize(keyLight() - origin)), 0.0);
        let spread = 0.13 + min(length(destination.xyz - origin), 20.0) * 0.025;
        let delta = length(point.xyz - destination.xyz) / spread;
        color += palette(i) * exp(-delta * delta * 1.7) * facing * 0.70;
    }
    return color;
}
fn environment(direction: vec3f) -> vec3f {
    let key = pow(max(dot(direction, normalize(keyLight())), 0.0), 85.0);
    let fill = pow(max(dot(direction, normalize(FILL)), 0.0), 120.0);
    let pink = pow(max(dot(direction, normalize(vec3f(-2.0, -1.0, 2.0))), 0.0), 38.0);
    let cyan = pow(max(dot(direction, normalize(vec3f(3.5, -0.6, 1.6))), 0.0), 50.0);
    let strip = pow(max(1.0 - abs(direction.y * 0.62 + direction.x * 0.35 - 0.2), 0.0), 35.0);
    return vec3f(0.06, 0.065, 0.09) + vec3f(7.0, 6.3, 8.0) * key + vec3f(3.4, 4.5, 7.0) * fill + vec3f(3.6, 0.8, 3.0) * pink + vec3f(0.5, 2.6, 4.2) * cyan + vec3f(1.0, 0.8, 1.4) * strip;
}
fn haze(origin: vec3f, direction: vec3f, distance: f32) -> vec3f {
    var result = vec3f(0.0);
    for (var i = 0; i < 9; i++) {
        let p = origin + direction * (f32(i) + 0.5) * distance / 9.0;
        let keyCone = pow(max(dot(normalize(p - keyLight()), normalize(-keyLight())), 0.0), 65.0);
        let fillCone = pow(max(dot(normalize(p - FILL), normalize(-FILL)), 0.0), 85.0);
        result += vec3f(0.24, 0.12, 0.43) * keyCone * 0.12;
        result += vec3f(0.10, 0.22, 0.40) * fillCone * 0.10;
    }
    return result;
}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let size = params.resolution;
    let mobile = params.viewportWidth < 1000.0;
    let center = select(vec2f(0.73, 0.50), vec2f(0.50, 0.73), mobile);
    let scale = min(size.x, size.y);
    let screen = (uv - center) * size / scale * 2.0;
    let camera = vec3f(0.0, 0.10, 3.4);
    let forward = normalize(-camera);
    let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
    let up = cross(right, forward);
    let ray = normalize(forward * 2.65 + right * screen.x - up * screen.y);
    let projection = dot(camera, ray);
    let discriminant = projection * projection - dot(camera, camera) + RADIUS * RADIUS;
    let room = roomHit(camera, ray);
    var distance = min(length(room.xyz - camera), 12.0);
    var color = roomColor(room);
    // Colored spill in the haze around the stage; keep the copy side quiet.
    let stage = screen - vec2f(0.1, -0.1);
    color += vec3f(0.018, 0.003, 0.055) * exp(-dot(stage, stage) * 1.1);
    color += vec3f(0.003, 0.025, 0.055) * exp(-dot(stage - vec2f(0.7, -0.5), stage - vec2f(0.7, -0.5)) * 2.5);
    let hitDistance = -projection - sqrt(max(discriminant, 0.0));
    let point = camera + ray * hitDistance;
    let smoothNormal = normalize(point);
    let coordinates = ballUV(smoothNormal);
    let gridFootprint = fwidth(coordinates * GRID);
    let silhouetteFootprint = max(fwidth(discriminant), 0.00001);
    if (discriminant > -silhouetteFootprint * 0.5) {
        distance = hitDistance;
        let cell = floor(coordinates * GRID);
        let tile = fract(coordinates * GRID);
        let edges = min(tile, 1.0 - tile);
        let gap = min(edges.x * 0.75, edges.y);
        let pixelWidth = max(gridFootprint.x * 0.75, gridFootprint.y);
        let inset = smoothstep(0.006 - pixelWidth * 0.5, 0.006 + pixelWidth * 0.5, gap);
        let bevel = smoothstep(0.025, 0.10, gap);
        let n = normalize(mix(smoothNormal, cellNormal(cell), bevel * 0.95));
        let tint = palette(u32(cell.x + cell.y * 2.0));
        let keyDirection = normalize(keyLight() - point);
        let fillDirection = normalize(FILL - point);
        let diffuse = max(dot(n, keyDirection), 0.0) + max(dot(n, fillDirection), 0.0) * 0.3;
        let reflected = reflect(ray, n);
        let mirroredRoom = roomHit(point + n * 0.005, reflected);
        let mirror = environment(reflected) + roomColor(mirroredRoom) * 0.25;
        var face = vec3f(0.82, 0.84, 0.91) * (0.035 + diffuse * 0.12) * (0.88 + hash(cell) * 0.16);
        face += mirror * mix(vec3f(0.92), tint, 0.12) * 1.55;
        // Each small mirror has its own slight alignment; glints travel across the grid.
        let microNormal = normalize(n + fromBall(vec3f(hash(cell) - 0.5, hash(cell.yx) - 0.5, 0.0)) * 0.045);
        let sparkle = pow(max(dot(microNormal, normalize(keyDirection - ray)), 0.0), 650.0);
        face += vec3f(14.0, 11.0, 16.0) * sparkle;
        let edgeShine = pow(1.0 - bevel, 5.0) * max(dot(n, keyDirection), 0.0);
        face += vec3f(0.55, 0.65, 0.95) * edgeShine;
        let rim = pow(1.0 - max(dot(n, -ray), 0.0), 3.0);
        face += tint * rim * 0.10;
        let ball = mix(face * 0.55, face, inset);
        let coverage = smoothstep(-silhouetteFootprint * 0.5, silhouetteFootprint * 0.5, discriminant);
        color = mix(color, ball, coverage);
    }
    color += haze(camera, ray, distance);
    // Small lens glints follow the facets that actually face each spotlight.
    for (var i = 0u; i < 4u; i++) {
        let lights = array<vec3f, 4>(keyLight(), FILL, vec3f(-2.0, -1.0, 2.0), vec3f(3.5, -0.6, 1.6));
        let light = lights[i];
        let normal = normalize(normalize(light) + normalize(camera));
        let facet = cellNormal(floor(ballUV(normal) * GRID));
        let strength = pow(max(dot(normal, facet), 0.0), 330.0);
        let point = normal * RADIUS;
        let relative = point - camera;
        let depth = dot(relative, forward);
        let position = vec2f(dot(relative, right), -dot(relative, up)) * 2.65 / depth;
        let delta = screen - position;
        let core = exp(-dot(delta, delta) * 2300.0);
        let streak = exp(-abs(delta.x) * 700.0 - abs(delta.y) * 14.0) + exp(-abs(delta.y) * 700.0 - abs(delta.x) * 14.0);
        let bloom = exp(-length(delta) * 30.0) * 0.40;
        color += vec3f(1.4, 1.25, 1.8) * strength * (core * 1.8 + streak + bloom);
    }
    let edge = smoothstep(0.05, 0.5, uv.y) * (1.0 - smoothstep(0.92, 1.0, uv.y));
    color = mix(vec3f(0.016, 0.020, 0.043), color, 0.4 + 0.6 * edge);
    color = color / (1.0 + color * 0.45);
    return vec4f(color, 1.0);
}
