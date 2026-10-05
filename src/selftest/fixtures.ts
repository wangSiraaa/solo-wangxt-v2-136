// 自测夹具：变量遮蔽
export const shadowing = `// 顶层注释保持不动
function demo() {
  const count = 1; // 外层 count
  const doubled = count * 2;

  for (const count of [1, 2]) {
    // 内层 count 遮蔽外层，改名外层时这里必须排除
    console.log(count);
  }

  function inner(count: number) {
    // 参数 count 是第三个绑定
    return count + doubled;
  }

  return count + inner(count);
}

const alsoCount = { count: 9 }; // 属性 count：又一个符号
`;
