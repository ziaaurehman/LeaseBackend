const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM = {
  email: process.env.SENDGRID_FROM_EMAIL,
  name:  process.env.FROM_NAME || 'Lease Management',
};

const sendEmail = async ({ to, subject, html, text }) => {
  const msg = {
    to,
    from: FROM,
    subject,
    html,
    text: text || subject,
  };

  await sgMail.send(msg);
};

// --- templates ---

const sendWelcomeEmail = async ({ to, name, password }) => {
  await sendEmail({
    to,
    subject: 'Your Lease Management Account',
    html: `
      <h2>Welcome, ${name}</h2>
      <p>Your account has been created.</p>
      <p><strong>Email:</strong> ${to}</p>
      <p><strong>Temporary Password:</strong> ${password}</p>
      <p>Please log in and change your password.</p>
    `,
  });
};

const sendPasswordResetEmail = async ({ to, name, resetLink }) => {
  await sendEmail({
    to,
    subject: 'Password Reset Request',
    html: `
      <h2>Hello, ${name}</h2>
      <p>Click the link below to reset your password:</p>
      <a href="${resetLink}">${resetLink}</a>
      <p>This link expires in 1 hour.</p>
    `,
  });
};

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
};
