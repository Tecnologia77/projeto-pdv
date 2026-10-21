# STOCK PDV

Sistema de frente de caixa, estoque e cardápio publicado em https://pdvstock.com.br/

## Cópia recuperada em 21/10/2026

O GitHub tinha só uma versão antiga (HTML, `app.js` e `style.css`). Esta cópia foi baixada do site que está no ar, que é a versão atual do sistema.

Arquivos do site:

- `index.html`, `app.js`, `styles.css`, `ai.js`, `pwa.js`
- `firebase-config.js`, `qz-security.js`, `qz-certificate.txt`
- `delivery.html`, `delivery.js`, `delivery.css`
- `manifest.webmanifest`, `manifest-delivery.webmanifest`, `favicon.ico`, `icons/`
- `firestore.rules`, `storage.rules`

`style.css` e `404.html` são da versão antiga que já estava neste repositório. O site atual usa `styles.css`.

## Onde estão os dados da loja

Produtos, vendas, clientes, caixa e licenças **não ficam nestes arquivos**. Eles ficam no Cloud Firestore do projeto Firebase `adega-brothers`.

Para exportar os dados em outro computador:

1. Abra https://console.firebase.google.com e entre com o e-mail administrador da loja (`piresgustavo03@gmail.com`).
2. Abra o projeto **adega-brothers**.
3. Em **Firestore Database**, use **Import/Export** (ou o console) para exportar as coleções `stores`, `customers`, `licenses` e `storePublic`.
4. Dentro de cada loja (`stores/{uid}`) estão `products`, `sales`, `pendingAccounts`, `deliveryOrders` e as demais coleções do caixa.

Sem esse login do Google não há como copiar o banco. O computador antigo só guardava uma sessão do navegador; a base oficial é o Firebase.

## Segurança

O GitHub bloqueia chave secreta neste repositório. Por isso a cópia daqui está sem:

- a chave do Gemini e a chave do ImgBB (`firebase-config.js` no site ainda tem as duas)
- a chave privada da impressora (`https://pdvstock.com.br/qz-private-key.pem`)

Baixe esses arquivos no navegador para o computador novo, guarde fora do GitHub e troque as chaves. Elas já estão visíveis para quem abre o site. Deixe este repositório privado se ele for só seu.

Não coloque senhas neste arquivo.
