// 설명서 미리보기 캡처용 예시 대화 — 마크다운(굵게·코드·제목·목록)과 이어진 도구 호출 묶음이 보이게
export const DEMO_SESSION = {
  model: 'gpt-5-codex',
  stats: { toolCalls: 3, droppedReasoning: 0, droppedSystem: 0, unknownLines: 0 },
  messages: [
    { role: 'user', blocks: [{ kind: 'text', text: '장바구니에서 결제로 넘어갈 때 쿠폰 할인이 두 번 적용되는 것 같아. 흐름을 정리해서 고쳐 줘.' }] },
    {
      role: 'assistant',
      blocks: [
        { kind: 'text', text: '결제 흐름을 확인해 보니 `applyCoupon()` 이 **장바구니와 결제 단계에서 각각** 호출되고 있습니다.' },
        { kind: 'tool', name: 'exec', input: JSON.stringify({ cmd: 'rg -n "applyCoupon" src/' }), output: 'src/cart/CartService.ts:42\nsrc/checkout/CheckoutService.ts:88', isError: false },
        { kind: 'tool', name: 'exec', input: JSON.stringify({ cmd: 'sed -n 80,100p src/checkout/CheckoutService.ts' }), output: 'const total = applyCoupon(cart.total, coupon);', isError: false },
        { kind: 'text', text: '### 수정 내용\n- `CheckoutService` 에서 쿠폰을 다시 계산하던 부분을 없앴습니다\n- 결제 단계는 장바구니 합계를 그대로 씁니다\n- 관련 테스트 3개를 추가했습니다' },
      ],
    },
    { role: 'user', blocks: [{ kind: 'text', text: '좋아. 테스트도 돌려 줘.' }] },
    {
      role: 'assistant',
      blocks: [
        { kind: 'tool', name: 'exec', input: JSON.stringify({ cmd: 'npm test -- checkout' }), output: '12 passed', isError: false },
        { kind: 'text', text: '결제 관련 테스트 **12개가 모두 통과**했습니다.' },
      ],
    },
  ],
};
