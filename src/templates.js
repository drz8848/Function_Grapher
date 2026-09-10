/*
 * templates.js — 函数模板库（数据模块，浏览器 / Node 通用）
 * 移植自 mathflow 的 33 个函数模板（8 大类），另附曲面 / 隐式曲面示例。
 * color 使用 CSS 十六进制字符串。
 */
(function (root) {
  'use strict';

  var FUNCTION_TEMPLATES = [
    // 三角函数
    { id: 'sine', label: 'sin(x)', src: 'y(x)=sin(x)', color: '#ef5350', category: '三角函数' },
    { id: 'cosine', label: 'cos(x)', src: 'y(x)=cos(x)', color: '#4f8ef7', category: '三角函数' },
    { id: 'tangent', label: 'tan(x)', src: 'y(x)=tan(x)', color: '#fcc419', category: '三角函数' },
    { id: 'secant', label: 'sec(x)', src: 'y(x)=1/cos(x)', color: '#ff922b', category: '三角函数' },
    { id: 'cosecant', label: 'csc(x)', src: 'y(x)=1/sin(x)', color: '#ffd166', category: '三角函数' },
    { id: 'cotangent', label: 'cot(x)', src: 'y(x)=1/tan(x)', color: '#e8a87c', category: '三角函数' },
    // 双曲函数
    { id: 'sinh', label: 'sinh(x)', src: 'y(x)=sinh(x)', color: '#ef5350', category: '双曲函数' },
    { id: 'cosh', label: 'cosh(x)', src: 'y(x)=cosh(x)', color: '#4f8ef7', category: '双曲函数' },
    { id: 'tanh', label: 'tanh(x)', src: 'y(x)=tanh(x)', color: '#fcc419', category: '双曲函数' },
    // 多项式
    { id: 'line', label: 'ax+b', src: 'y(x)=a*x+b', color: '#51cf66', category: '多项式' },
    { id: 'quadratic', label: 'ax²+bx+c', src: 'y(x)=a*x^2+b*x+c', color: '#cc5de8', category: '多项式' },
    { id: 'cubic', label: 'ax³+bx+c', src: 'y(x)=a*x^3+b*x+c', color: '#ff922b', category: '多项式' },
    { id: 'quartic', label: 'ax⁴+bx²+c', src: 'y(x)=a*x^4+b*x^2+c', color: '#51cf66', category: '多项式' },
    // 指数 / 对数
    { id: 'exponential', label: 'eˣ', src: 'y(x)=exp(x)', color: '#22b8cf', category: '指数/对数' },
    { id: 'logarithm', label: 'ln(x)', src: 'y(x)=log(x)', color: '#4f8ef7', category: '指数/对数' },
    { id: 'log10', label: 'lg(x)', src: 'y(x)=log10(x)', color: '#845ef7', category: '指数/对数' },
    { id: 'log2', label: 'log₂(x)', src: 'y(x)=log2(x)', color: '#22b8cf', category: '指数/对数' },
    // 有理函数
    { id: 'reciprocal', label: '1/x', src: 'y(x)=1/x', color: '#ffd166', category: '有理函数' },
    { id: 'rational1', label: '1/(x²+1)', src: 'y(x)=1/(x^2+1)', color: '#ef5350', category: '有理函数' },
    { id: 'rational2', label: '(x+1)/(x-1)', src: 'y(x)=(x+1)/(x-1)', color: '#cc5de8', category: '有理函数' },
    // 分段 / 幂函数
    { id: 'absolute', label: '|x|', src: 'y(x)=abs(x)', color: '#ef5350', category: '分段/幂函数' },
    { id: 'sqrt', label: '√x', src: 'y(x)=sqrt(x)', color: '#51cf66', category: '分段/幂函数' },
    { id: 'cbrt', label: '∛x', src: 'y(x)=cbrt(x)', color: '#22b8cf', category: '分段/幂函数' },
    { id: 'power', label: 'x^a', src: 'y(x)=x^a', color: '#ff922b', category: '分段/幂函数' },
    // 特殊函数
    { id: 'gaussian', label: 'Gauss', src: 'y(x)=exp(-x^2)', color: '#4f8ef7', category: '特殊函数' },
    { id: 'logistic', label: 'Logistic', src: 'y(x)=1/(1+exp(-x))', color: '#fcc419', category: '特殊函数' },
    { id: 'sigmoid', label: 'Sigmoid', src: 'y(x)=1/(1+exp(-x))', color: '#51cf66', category: '特殊函数' },
    { id: 'sinc', label: 'sinc(x)', src: 'y(x)=sin(x)/x', color: '#cc5de8', category: '特殊函数' },
    // 取整函数
    { id: 'floor', label: '⌊x⌋', src: 'y(x)=floor(x)', color: '#e8a87c', category: '取整函数' },
    { id: 'ceil', label: '⌈x⌉', src: 'y(x)=ceil(x)', color: '#d4a373', category: '取整函数' },
    { id: 'round', label: 'round(x)', src: 'y(x)=round(x)', color: '#ccd5ae', category: '取整函数' },
    { id: 'sign', label: 'sgn(x)', src: 'y(x)=sign(x)', color: '#a98467', category: '取整函数' },
  ];

  /* 曲面与隐式曲面示例（本项目特有，一并提供模板） */
  var SURFACE_TEMPLATES = [
    { id: 's-paraboloid', label: 'z=x²+y²', src: 'z(x,y)=x^2+y^2', color: '#ef5350', category: '曲面示例' },
    { id: 's-saddle', label: 'z=x²−y²', src: 'z(x,y)=x^2-y^2', color: '#4f8ef7', category: '曲面示例' },
    { id: 's-ripple', label: '波纹', src: 'z(x,y)=sin(sqrt(x^2+y^2)*2)/(sqrt(x^2+y^2)+0.2)', color: '#51cf66', category: '曲面示例' },
    { id: 's-eggbox', label: '蛋盒', src: 'z(x,y)=sin(x)*cos(y)', color: '#fcc419', category: '曲面示例' },
    { id: 'i-sphere', label: '球面 x²+y²+z²=1', src: 'x^2+y^2+z^2=1', color: '#22b8cf', category: '隐式曲面' },
    { id: 'i-hyper', label: '单叶双曲面', src: 'x^2+y^2-z^2=1', color: '#cc5de8', category: '隐式曲面' },
    { id: 'i-torus', label: '环面', src: '(sqrt(x^2+y^2)-2)^2+z^2=1', color: '#ff922b', category: '隐式曲面' },
  ];

  function groupBy(list) {
    var map = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].category;
      if (!map[c]) { map[c] = []; order.push(c); }
      map[c].push(list[i]);
    }
    return order.map(function (c) { return { category: c, templates: map[c] }; });
  }

  function getTemplate(id) {
    for (var i = 0; i < FUNCTION_TEMPLATES.length; i++) {
      if (FUNCTION_TEMPLATES[i].id === id) return FUNCTION_TEMPLATES[i];
    }
    for (var j = 0; j < SURFACE_TEMPLATES.length; j++) {
      if (SURFACE_TEMPLATES[j].id === id) return SURFACE_TEMPLATES[j];
    }
    return null;
  }

  var api = {
    FUNCTION_TEMPLATES: FUNCTION_TEMPLATES,
    SURFACE_TEMPLATES: SURFACE_TEMPLATES,
    functionCategories: function () { return groupBy(FUNCTION_TEMPLATES); },
    surfaceCategories: function () { return groupBy(SURFACE_TEMPLATES); },
    getTemplate: getTemplate,
  };

  root.FPlotTemplates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
