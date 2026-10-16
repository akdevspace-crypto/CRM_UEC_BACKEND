const nodemailer = require('nodemailer');

const user = process.env.EMAIL_USER;
const pass = process.env.EMAIL_PASS;

let transporter = null;
if (user && pass) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT, 10) || 465,
    secure: true,
    auth: { user, pass }
  });
}

const sendEmailReply = async (toEmail, subject, htmlBody, inReplyTo, references) => {
  if (!transporter) {
    console.warn('❌ Email provider not configured (missing EMAIL_USER or EMAIL_PASS)');
    return { success: false, error: 'Email service credentials not configured' };
  }
  try {
    const mailOptions = {
      from: `"ElderCare CRM" <${user}>`,
      to: toEmail,
      subject: subject,
      html: htmlBody,
      inReplyTo: inReplyTo,
      references: references
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('❌ Nodemailer Error:', err);
    return { success: false, error: err.message };
  }
};

module.exports = { sendEmailReply };
