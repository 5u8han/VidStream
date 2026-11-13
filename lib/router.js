'use strict';

function compile(pattern) {
  const keys = [];
  const regexStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexStr}$`), keys };
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, ...compile(pattern), handler });
  }

  get(pattern, handler) {
    this.add('GET', pattern, handler);
  }
  post(pattern, handler) {
    this.add('POST', pattern, handler);
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      try {
        route.keys.forEach((key, i) => (params[key] = decodeURIComponent(m[i + 1])));
      } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
      }
      return { handler: route.handler, params };
    }
    return null;
  }
}

module.exports = { Router };
