/**
 * pinyin.mjs -- zero-dependency Hanzi -> pinyin helper for the Character Codex editor.
 *
 * Classic browser script: there are no import/export statements, so it can be loaded
 * directly with `<script src="scripts/lib/pinyin.mjs">`, and it publishes the API as
 * `window.Pinyin` (also mirrored on `globalThis.Pinyin`).
 *
 * Node loading note. The file ends with the standard CommonJS interop line
 *
 *   if (typeof module !== 'undefined' && module.exports) module.exports = Pinyin;
 *
 * which works when the file is evaluated as CommonJS -- e.g. after renaming it to
 * `pinyin.cjs`, or under any CJS-aware loader/bundler:
 *
 *   const Pinyin = require('./pinyin.cjs');
 *   const Pinyin = (await import('file:///D:/.../scripts/lib/pinyin.cjs')).default;
 *
 * It cannot make `await import('...pinyin.mjs')` return the API: Node treats a `.mjs`
 * extension as an ES module unconditionally, and an ES module namespace can only be
 * filled by `export` statements, which a classic script must not contain. Importing the
 * `.mjs` path still executes the file (so `globalThis.Pinyin` gets set) but the imported
 * namespace is empty. Use the `.cjs` form, or read `globalThis.Pinyin` after importing.
 *
 * Coverage: all 737 unique Hanzi that occur anywhere in data/_index.json, a superset
 * of the 201 unique Hanzi used by its 131 `characters` names.
 *
 * Readings are one per Hanzi, chosen so character names come out right:
 * 雷电将军 -> leidianjiangjun, 丝柯克 -> sikeke, 阿贝多 -> abeiduo, 行秋 -> xingqiu,
 * 重云 -> chongyun, 凝光 -> ningguang, 魈 -> xiao, 菈乌玛 -> lawuma,
 * 梦见月瑞希 -> mengjianyueruixi, 希诺宁 -> xinuoning, 玛薇卡 -> maweika,
 * 玛拉妮 -> malani. The PHRASES table below patches the few polyphones needing two readings.
 *
 * Syllables are toneless lowercase ASCII, using "lv"/"nv" for lu:/ny:. Hanzi with no known
 * reading fall through unchanged rather than being dropped.
 */
(function (root) {
  'use strict';

  /** char -> toneless lowercase syllable */
  var DICT = {
    \u4e00: "yi", \u4e03: "qi", \u4e07: "wan", \u4e0a: "shang", \u4e0b: "xia", \u4e0d: "bu", \u4e0e: "yu", \u4e14: "qie",
    \u4e16: "shi", \u4e1c: "dong", \u4e1d: "si", \u4e2d: "zhong", \u4e34: "lin", \u4e38: "wan", \u4e3d: "li", \u4e45: "jiu",
    \u4e49: "yi", \u4e4b: "zhi", \u4e4c: "wu", \u4e50: "le", \u4e58: "cheng", \u4e5d: "jiu", \u4e66: "shu", \u4e71: "luan",
    \u4e8b: "shi", \u4e91: "yun", \u4e94: "wu", \u4e9a: "ya", \u4ead: "ting", \u4eba: "ren", \u4ed9: "xian", \u4ee5: "yi",
    \u4eea: "yi", \u4f0a: "yi", \u4f18: "you", \u4f1f: "wei", \u4f26: "lun", \u4f3d: "jia", \u4f4f: "zhu", \u4f59: "yu",
    \u4f5c: "zuo", \u4f63: "yong", \u4f7f: "shi", \u4f8d: "shi", \u4f9d: "yi", \u4fbf: "bian", \u4fe1: "xin", \u5076: "ou",
    \u50b2: "ao", \u513f: "er", \u5146: "zhao", \u5149: "guang", \u514b: "ke", \u516b: "ba", \u516c: "gong", \u5170: "lan",
    \u5175: "bing", \u5178: "dian", \u5179: "zi", \u5192: "mao", \u519b: "jun", \u51ac: "dong", \u51b0: "bing", \u51b2: "chong",
    \u51b3: "jue", \u51b7: "leng", \u51dd: "ning", \u51ef: "kai", \u5200: "dao", \u5203: "ren", \u5207: "qie", \u521d: "chu",
    \u5229: "li", \u523a: "ci", \u523b: "ke", \u5251: "jian", \u5267: "ju", \u529b: "li", \u529f: "gong", \u52a8: "dong",
    \u52c7: "yong", \u52d8: "kan", \u52fe: "gou", \u5316: "hua", \u5317: "bei", \u5319: "chi", \u5323: "xia", \u533b: "yi",
    \u5341: "shi", \u5343: "qian", \u534e: "hua", \u5361: "ka", \u5362: "lu", \u5370: "yin", \u5377: "juan", \u5384: "e",
    \u5386: "li", \u5389: "li", \u539f: "yuan", \u53cd: "fan", \u53d8: "bian", \u53e3: "kou", \u53e4: "gu", \u53ef: "ke",
    \u53f2: "shi", \u53f6: "ye", \u53f9: "tan", \u5403: "chi", \u541f: "yin", \u542b: "han", \u5439: "chui", \u5484: "duo",
    \u548c: "he", \u54c8: "ha", \u54cd: "xiang", \u54e5: "ge", \u54e8: "shao", \u5599: "hui", \u559c: "xi", \u55df: "jie",
    \u55e3: "si", \u5609: "jia", \u561f: "du", \u5668: "qi", \u566c: "shi", \u56db: "si", \u56de: "hui", \u56e2: "tuan",
    \u56ed: "yuan", \u56fa: "gu", \u56fd: "guo", \u56fe: "tu", \u5723: "sheng", \u5730: "di", \u574a: "fang", \u574e: "kan",
    \u575a: "jian", \u575e: "wu", \u57a0: "yin", \u57c3: "ai", \u57ce: "cheng", \u57df: "yu", \u57fa: "ji", \u5807: "jin",
    \u5854: "ta", \u585e: "sai", \u5883: "jing", \u58a8: "mo", \u58eb: "shi", \u58f0: "sheng", \u590f: "xia", \u591a: "duo",
    \u591c: "ye", \u5927: "da", \u5929: "tian", \u5947: "qi", \u5948: "nai", \u594f: "zou", \u5965: "ao", \u5973: "nv",
    \u5982: "ru", \u59ae: "ni", \u59b2: "da", \u5a05: "ya", \u5a1c: "na", \u5b50: "zi", \u5b51: "jie", \u5b57: "zi",
    \u5b66: "xue", \u5b81: "ning", \u5b88: "shou", \u5b89: "an", \u5b97: "zong", \u5b98: "guan", \u5b9d: "bao", \u5b9e: "shi",
    \u5ba4: "shi", \u5bab: "gong", \u5bb3: "hai", \u5bb5: "xiao", \u5bb6: "jia", \u5bc2: "ji", \u5bd2: "han", \u5bdd: "qin",
    \u5bf8: "cun", \u5bf9: "dui", \u5bfc: "dao", \u5c04: "she", \u5c06: "jiang", \u5c0a: "zun", \u5c11: "shao", \u5c14: "er",
    \u5c16: "jian", \u5c18: "chen", \u5c3c: "ni", \u5c40: "ju", \u5c71: "shan", \u5c90: "qi", \u5ca9: "yan", \u5ce1: "xia",
    \u5cf0: "feng", \u5ddd: "chuan", \u5de1: "xun", \u5de5: "gong", \u5df7: "xiang", \u5e03: "bu", \u5e0c: "xi", \u5e37: "wei",
    \u5e55: "mu", \u5e73: "ping", \u5e78: "xing", \u5e7b: "huan", \u5e7d: "you", \u5eca: "lang", \u5f02: "yi", \u5f13: "gong",
    \u5f15: "yin", \u5f25: "mi", \u5f26: "xian", \u5f39: "tan", \u5f55: "lu", \u5f62: "xing", \u5f69: "cai", \u5f71: "ying",
    \u5f80: "wang", \u5f84: "jing", \u5f8b: "lv", \u5f92: "tu", \u5fa1: "yu", \u5fb7: "de", \u5fc3: "xin", \u5fc6: "yi",
    \u5fcd: "ren", \u5ff5: "nian", \u6012: "nu", \u601c: "lian", \u601d: "si", \u6027: "xing", \u6069: "en", \u606f: "xi",
    \u6070: "qia", \u6076: "e", \u6094: "hui", \u60a0: "you", \u60ac: "xuan", \u60f3: "xiang", \u610f: "yi", \u6167: "hui",
    \u620d: "shu", \u620f: "xi", \u6218: "zhan", \u624b: "shou", \u6253: "da", \u6258: "tuo", \u62a4: "hu", \u62a5: "bao",
    \u62c9: "la", \u62fe: "shi", \u632f: "zhen", \u633d: "wan", \u6398: "jue", \u63a0: "lve", \u63a2: "tan", \u63d0: "ti",
    \u643a: "xie", \u6469: "mo", \u6492: "sa", \u64bc: "han", \u652f: "zhi", \u653e: "fang", \u6545: "gu", \u6551: "jiu",
    \u6559: "jiao", \u6587: "wen", \u6597: "dou", \u65a9: "zhan", \u65ab: "zhuo", \u65ad: "duan", \u65af: "si", \u65b0: "xin",
    \u65c5: "lv", \u65cb: "xuan", \u65d7: "qi", \u65e0: "wu", \u65e5: "ri", \u65e9: "zao", \u65f6: "shi", \u660e: "ming",
    \u6614: "xi", \u661f: "xing", \u662d: "zhao", \u663e: "xian", \u6653: "xiao", \u665a: "wan", \u6668: "chen", \u6674: "qing",
    \u6676: "jing", \u6697: "an", \u66d9: "shu", \u66da: "meng", \u66dc: "yao", \u66f2: "qu", \u6700: "zui", \u6708: "yue",
    \u6709: "you", \u670d: "fu", \u670f: "fei", \u671b: "wang", \u6728: "mu", \u672a: "wei", \u672b: "mo", \u672f: "shu",
    \u673a: "ji", \u6756: "zhang", \u675c: "du", \u6761: "tiao", \u6765: "lai", \u676f: "bei", \u6770: "jie", \u6775: "chu",
    \u677e: "song", \u6781: "ji", \u6797: "lin", \u679c: "guo", \u679d: "zhi", \u67aa: "qiang", \u67ab: "feng", \u67cf: "bai",
    \u67d3: "ran", \u67d4: "rou", \u67da: "you", \u67ef: "ke", \u6807: "biao", \u683c: "ge", \u6842: "gui", \u6843: "tao",
    \u6851: "sang", \u6885: "mei", \u68a6: "meng", \u68c9: "mian", \u68d2: "bang", \u68ee: "sen", \u697c: "lou", \u69b4: "liu",
    \u69ca: "shuo", \u6b27: "ou", \u6b46: "xin", \u6b4c: "ge", \u6b63: "zheng", \u6b66: "wu", \u6b8b: "can", \u6b96: "zhi",
    \u6bc1: "hui", \u6bd4: "bi", \u6c34: "shui", \u6c83: "wo", \u6c89: "chen", \u6c90: "mu", \u6c99: "sha", \u6ca6: "lun",
    \u6cb3: "he", \u6cd5: "fa", \u6ce2: "bo", \u6ce8: "zhu", \u6cf7: "long", \u6cfd: "ze", \u6d1b: "luo", \u6d25: "jin",
    \u6d41: "liu", \u6d4b: "ce", \u6d6a: "lang", \u6d6e: "fu", \u6d74: "yu", \u6d77: "hai", \u6d85: "nie", \u6d8c: "yong",
    \u6df1: "shen", \u6e0a: "yuan", \u6e14: "yu", \u6e21: "du", \u6e29: "wen", \u6e38: "you", \u6e56: "hu", \u6e7e: "wan",
    \u6e83: "kui", \u6e90: "yuan", \u6ea2: "yi", \u6ee1: "man", \u6f29: "xuan", \u6fb9: "dan", \u706b: "huo", \u706d: "mie",
    \u706f: "deng", \u7070: "hui", \u707e: "zai", \u7089: "lu", \u708e: "yan", \u70bc: "lian", \u70bd: "chi", \u70c8: "lie",
    \u70df: "yan", \u70ec: "jin", \u711a: "fen", \u7131: "yan", \u7194: "rong", \u71e7: "sui", \u7231: "ai", \u7259: "ya",
    \u7262: "lao", \u7279: "te", \u72c2: "kuang", \u72fc: "lang", \u730e: "lie", \u7330: "ya", \u7389: "yu", \u738b: "wang",
    \u739b: "ma", \u73af: "huan", \u73b0: "xian", \u73c0: "po", \u73c2: "ke", \u73ca: "shan", \u73cf: "jue", \u73d0: "fa",
    \u73d1: "long", \u73e0: "zhu", \u73ed: "ban", \u7403: "qiu", \u7406: "li", \u7433: "lin", \u7434: "qin", \u745a: "hu",
    \u745e: "rui", \u7476: "yao", \u749e: "pu", \u74e6: "wa", \u74f6: "ping", \u7518: "gan", \u751f: "sheng", \u7531: "you",
    \u7532: "jia", \u7533: "shen", \u7535: "dian", \u7537: "nan", \u754c: "jie", \u767d: "bai", \u7684: "de", \u7687: "huang",
    \u76c8: "ying", \u76d1: "jian", \u76db: "sheng", \u76ee: "mu", \u771f: "zhen", \u7763: "du", \u77b3: "tong", \u77db: "mao",
    \u77e2: "shi", \u77f3: "shi", \u7802: "sha", \u7817: "che", \u781a: "yan", \u7834: "po", \u7855: "shuo", \u788e: "sui",
    \u78a7: "bi", \u78d0: "pan", \u78f2: "qu", \u793a: "shi", \u793c: "li", \u7940: "si", \u795e: "shen", \u796d: "ji",
    \u7978: "huo", \u798f: "fu", \u79bb: "li", \u79cb: "qiu", \u79d8: "mi", \u7a3b: "dao", \u7a76: "jiu", \u7a79: "qiong",
    \u7a7a: "kong", \u7a7f: "chuan", \u7adf: "jing", \u7ae0: "zhang", \u7aed: "jie", \u7aef: "duan", \u7b14: "bi", \u7b1b: "di",
    \u7b3c: "long", \u7b51: "zhu", \u7b54: "da", \u7c3e: "lian", \u7c41: "lai", \u7c73: "mi", \u7cd6: "tang", \u7d22: "suo",
    \u7ea2: "hong", \u7ea6: "yue", \u7ea7: "ji", \u7eaf: "chun", \u7eb3: "na", \u7eb9: "wen", \u7eba: "fang", \u7ec3: "lian",
    \u7ec7: "zhi", \u7ec8: "zhong", \u7ecf: "jing", \u7ed3: "jie", \u7ed8: "hui", \u7edd: "jue", \u7eea: "xu", \u7eeb: "ling",
    \u7eee: "qi", \u7eef: "fei", \u7ef4: "wei", \u7eff: "lv", \u7f00: "zhui", \u7f18: "yuan", \u7f1a: "fu", \u7f28: "ying",
    \u7f51: "wang", \u7f57: "luo", \u7f6a: "zui", \u7f8e: "mei", \u7fa4: "qun", \u7fbd: "yu", \u7fce: "ling", \u7fe0: "cui",
    \u7fe1: "fei", \u7ffc: "yi", \u8000: "yao", \u8005: "zhe", \u804a: "liao", \u80e1: "hu", \u80fd: "neng", \u810a: "ji",
    \u8150: "fu", \u81ea: "zi", \u8239: "chuan", \u826f: "liang", \u8272: "se", \u827e: "ai", \u8292: "mang", \u8299: "fu",
    \u82ac: "fen", \u82ad: "ba", \u82b1: "hua", \u82c7: "wei", \u82cd: "cang", \u82e5: "ruo", \u82f1: "ying", \u831c: "qian",
    \u8349: "cao", \u8352: "huang", \u8389: "li", \u838e: "sha", \u83ab: "mo", \u83b1: "lai", \u83b7: "huo", \u83c8: "la",
    \u83f1: "ling", \u83f2: "fei", \u8403: "cui", \u8428: "sa", \u843d: "luo", \u846c: "zang", \u8482: "di", \u84dd: "lan",
    \u851a: "wei", \u857e: "lei", \u8587: "wei", \u8599: "ti", \u85cf: "cang", \u864e: "hu", \u8679: "hong", \u8680: "shi",
    \u86c7: "she", \u8702: "feng", \u8776: "die", \u878d: "rong", \u87ad: "chi", \u8840: "xue", \u884c: "xing", \u8854: "xian",
    \u888b: "dai", \u88ab: "bei", \u88c1: "cai", \u88df: "sha", \u897f: "xi", \u89c1: "jian", \u89c4: "gui", \u89d2: "jiao",
    \u8a93: "shi", \u8ba8: "tao", \u8bad: "xun", \u8bb0: "ji", \u8bba: "lun", \u8bc1: "zheng", \u8bd5: "shi", \u8bd7: "shi",
    \u8bdd: "hua", \u8bed: "yu", \u8bf8: "zhu", \u8bfa: "nuo", \u8c10: "xie", \u8c15: "yu", \u8c22: "xie", \u8c23: "yao",
    \u8c27: "mi", \u8c2d: "tan", \u8c31: "pu", \u8c90: "yu", \u8d1d: "bei", \u8d24: "xian", \u8d2f: "guan", \u8d3e: "jia",
    \u8d4c: "du", \u8d4e: "shu", \u8d50: "ci", \u8d5b: "sai", \u8d64: "chi", \u8d66: "she", \u8d6b: "he", \u8d77: "qi",
    \u8d85: "chao", \u8d8a: "yue", \u8ddd: "ju", \u8def: "lu", \u8f6e: "lun", \u8f7b: "qing", \u8f89: "hui", \u8f9b: "xin",
    \u8fb0: "chen", \u8fbe: "da", \u8fc7: "guo", \u8fd0: "yun", \u8fd1: "jin", \u8fde: "lian", \u8fea: "di", \u8ff7: "mi",
    \u8ff8: "beng", \u8ff9: "ji", \u8ffd: "zhui", \u9006: "ni", \u9010: "zhu", \u9014: "tu", \u9050: "xia", \u9053: "dao",
    \u9057: "yi", \u90a3: "na", \u90ce: "lang", \u9152: "jiu", \u916c: "chou", \u9192: "xing", \u91cc: "li", \u91cd: "chong",
    \u91ce: "ye", \u91d1: "jin", \u91ed: "gang", \u9488: "zhen", \u9489: "ding", \u9493: "diao", \u949f: "zhong", \u94a2: "gang",
    \u94a5: "yao", \u94a7: "jun", \u94a9: "gou", \u94ba: "yue", \u94bb: "zuan", \u94c1: "tie", \u94f6: "yin", \u94f8: "zhu",
    \u94fe: "lian", \u9501: "suo", \u950b: "feng", \u9524: "chui", \u952f: "ju", \u9539: "qiao", \u9547: "zhen", \u955c: "jing",
    \u9570: "lian", \u957f: "chang", \u95ea: "shan", \u95f2: "xian", \u95f4: "jian", \u9601: "ge", \u9614: "kuo", \u9633: "yang",
    \u963f: "a", \u964d: "jiang", \u9662: "yuan", \u9669: "xian", \u96c5: "ya", \u96c6: "ji", \u96e8: "yu", \u96ea: "xue",
    \u96ef: "wen", \u96f7: "lei", \u96fe: "wu", \u971c: "shuang", \u971e: "xia", \u9732: "lu", \u9738: "ba", \u9759: "jing",
    \u97f3: "yin", \u97f5: "yun", \u9882: "song", \u98ce: "feng", \u98de: "fei", \u98df: "shi", \u9970: "shi", \u9986: "guan",
    \u9999: "xiang", \u9a6c: "ma", \u9a91: "qi", \u9aa8: "gu", \u9ab8: "hai", \u9ad3: "sui", \u9b44: "po", \u9b48: "xiao",
    \u9b54: "mo", \u9c7c: "yu", \u9ccd: "qi", \u9e22: "yuan", \u9e23: "ming", \u9e26: "ya", \u9e64: "he", \u9e6b: "jiu",
    \u9e6e: "huan", \u9e70: "ying", \u9e7f: "lu", \u9ec4: "huang", \u9ece: "li", \u9ed1: "hei", \u9edb: "dai", \u9f50: "qi",
    \u9f99: "long"
  };

  /**
   * Multi-char overrides consulted before DICT, for polyphones that need both readings
   * in this dataset: 重 is chong in 重云 but zhong in 八重神子.
   */
  var PHRASES = {
    "八重": "ba zhong",
    "重云": "chong yun"
  };

  var PHRASE_KEYS = ["八重","重云"];
  var HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  /** True when `ch` is a single CJK ideograph. */
  function isHan(ch) {
    return typeof ch === 'string' && ch.length > 0 && HAN.test(ch);
  }

  /** Collapse whitespace and lowercase; used for query comparison. */
  function normalize(text) {
    return typeof text === 'string' ? text.replace(/\s+/g, '').toLowerCase() : '';
  }

  /**
   * Longest matching phrase override at position `i`, or null.
   * Returns { syllables: string[], length: number }.
   */
  function phraseAt(chars, i) {
    for (var k = 0; k < PHRASE_KEYS.length; k++) {
      var key = PHRASE_KEYS[k];
      var keyChars = Array.from(key);
      if (i + keyChars.length > chars.length) continue;
      var hit = true;
      for (var j = 0; j < keyChars.length; j++) {
        if (chars[i + j] !== keyChars[j]) { hit = false; break; }
      }
      if (hit) return { syllables: PHRASES[key].split(' '), length: keyChars.length };
    }
    return null;
  }

  /**
   * Single Hanzi -> toneless lowercase syllable, e.g. syllable('雷') === 'lei'.
   * Returns '' for anything that is not exactly one known Hanzi.
   */
  function syllable(ch) {
    if (typeof ch !== 'string') return '';
    var chars = Array.from(ch);
    if (chars.length !== 1 || !isHan(chars[0])) return '';
    return DICT[chars[0]] || '';
  }

  /**
   * Whole string -> full pinyin, e.g. full('雷电将军') === 'leidianjiangjun'.
   * Non-Hanzi characters are preserved verbatim (lowercased).
   */
  function full(text) {
    if (typeof text !== 'string') return '';
    var chars = Array.from(text);
    var out = '';
    for (var i = 0; i < chars.length; i++) {
      var ph = phraseAt(chars, i);
      if (ph) { out += ph.syllables.join(''); i += ph.length - 1; continue; }
      var ch = chars[i];
      out += isHan(ch) ? DICT[ch] || ch : ch.toLowerCase();
    }
    return out;
  }

  /**
   * Whole string -> consonant abbreviation, e.g. initials('雷电将军') === 'ldjj'.
   * One letter per Hanzi; unknown Hanzi and non-Hanzi are passed through lowercased.
   */
  function initials(text) {
    if (typeof text !== 'string') return '';
    var chars = Array.from(text);
    var out = '';
    for (var i = 0; i < chars.length; i++) {
      var ph = phraseAt(chars, i);
      if (ph) {
        for (var k = 0; k < ph.length; k++) out += ph.syllables[k].charAt(0);
        i += ph.length - 1;
        continue;
      }
      var ch = chars[i];
      if (isHan(ch)) {
        var s = DICT[ch];
        out += s ? s.charAt(0) : ch;
      } else {
        out += ch.toLowerCase();
      }
    }
    return out;
  }

  /**
   * Does `text` match `query`?
   * True when the query is a prefix or substring of the full pinyin, of the initials, or
   * of the raw text. Case- and whitespace-insensitive, so one search box can filter by
   * either initials ("ldjj", "skk") or full pinyin ("leidian", "sike"). Empty query matches.
   */
  function match(text, query) {
    var needle = normalize(query);
    if (!needle) return true;
    if (normalize(text).indexOf(needle) !== -1) return true;
    if (normalize(full(text)).indexOf(needle) !== -1) return true;
    return normalize(initials(text)).indexOf(needle) !== -1;
  }

  var Pinyin = {
    version: '1.0.0',
    /** char -> syllable table (treat as read-only). */
    dict: DICT,
    /** multi-char polyphone overrides (treat as read-only). */
    phrases: PHRASES,
    /** Number of Hanzi with a known reading. */
    size: 737,
    isHan: isHan,
    syllable: syllable,
    full: full,
    initials: initials,
    match: match
  };

  if (typeof window !== 'undefined') window.Pinyin = Pinyin;
  root.Pinyin = Pinyin;
  if (typeof module !== 'undefined' && module.exports) module.exports = Pinyin;
})(typeof globalThis !== 'undefined' ? globalThis : this);
